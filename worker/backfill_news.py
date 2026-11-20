"""Load official FDA/Benzinga archives or a supplied publisher export.
Examples: --source FDA ; --source Benzinga ; --source AccessWire --file archive.csv
Uses DATABASE_URL from the environment. No credentials are printed.
"""
import argparse
import calendar
import csv
import html
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse


def cutoff_date(now):
    month = now.month - 3
    year = now.year
    if month < 1:
        month += 12
        year -= 1
    return now.replace(year=year, month=month, day=min(now.day, calendar.monthrange(year, month)[1]))


def date_value(value):
    from email.utils import parsedate_to_datetime
    text = str(value or '').strip()
    try:
        value = datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError:
        try:
            value = parsedate_to_datetime(text)
        except (ValueError, TypeError):
            try:
                value = datetime.strptime(text, '%B %d, %Y')
            except ValueError:
                return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


class FdaLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.href = None
        self.parts = []
        self.items = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.href = dict(attrs).get('href')
            self.parts = []

    def handle_data(self, data):
        if self.href is not None:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'a' and self.href is not None:
            self.items.append((self.href, ' '.join(' '.join(self.parts).split())))
            self.href = None


def fda_pages(fetch, since, until):
    seen = set()
    for page in range(100):
        base = 'https://www.fda.gov/news-events/fda-newsroom/press-announcements'
        response = fetch(base, params={'page': page})
        parser = FdaLinks()
        parser.feed(response.text)
        dated = []
        batch = []
        for href, title in parser.items:
            if not re.search(r'/news-events/(?:fda-newsroom/)?press-announcements/', href):
                continue
            match = re.search(r'\b([A-Z][a-z]+ \d{1,2}, \d{4})\b', title)
            date = date_value(match[1]) if match else None
            if date is None:
                continue
            dated.append(date)
            url = urljoin(base, href)
            if url in seen:
                continue
            seen.add(url)
            if since <= date <= until:
                batch.append({'Title': title, 'Date': date.isoformat(), 'Url': url, 'Category': 'FDA', 'Ticker': 'FDA'})
        yield batch
        if not dated:
            raise RuntimeError(f'FDA page {page} has no dated announcement links; archive coverage is incomplete')
        if min(dated) < since:
            return
        if page and not batch and max(dated) >= since:
            raise RuntimeError('FDA archive repeated or returned no new items; coverage is incomplete')
        time.sleep(1)
    raise RuntimeError('FDA page safety limit reached; coverage is incomplete')


def benzinga_pages(fetch, since, until, token):
    if not token:
        raise RuntimeError('BENZINGA_API_TOKEN is required for the Benzinga archive')
    day = since.replace(hour=0, minute=0, second=0, microsecond=0)
    while day <= until:
        seen = set()
        for page in range(1000):
            response = fetch('https://api.benzinga.com/api/v2/news', params={
                'token': token, 'dateFrom': day.date().isoformat(), 'dateTo': day.date().isoformat(),
                'page': page, 'pageSize': 100, 'displayOutput': 'full', 'sort': 'created:asc',
            }, headers={'Accept': 'application/json'})
            data = response.json()
            data = data if isinstance(data, list) else data.get('news')
            if not isinstance(data, list):
                raise RuntimeError('Unrecognized Benzinga archive response')
            if not data:
                break
            batch = []
            for item in data:
                url = item.get('url', '')
                if url in seen:
                    continue
                seen.add(url)
                batch.append({'Title': item.get('title', ''), 'Date': item.get('created', ''), 'Url': url,
                              'Ticker': ','.join(stock.get('name') or stock.get('symbol') or '' for stock in item.get('stocks', []))})
            if not batch:
                raise RuntimeError('Benzinga repeated a page; archive coverage is incomplete')
            yield batch
            if len(data) < 100:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Benzinga page safety limit reached; coverage is incomplete')
        day += timedelta(days=1)
        time.sleep(1)


def file_batches(path):
    with Path(path).open(encoding='utf-8-sig', newline='') as handle:
        data = json.load(handle) if Path(path).suffix.lower() == '.json' else list(csv.DictReader(handle))
    rows = data if isinstance(data, list) else data.get('results', [])
    if not rows:
        raise RuntimeError('Export contains no records')
    for offset in range(0, len(rows), 500):
        yield rows[offset:offset + 500]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, choices=['FDA', 'Benzinga', 'AccessWire', 'GlobeNewswire'])
    parser.add_argument('--file', help='Authorized JSON or CSV export: Title, Date, Url; optional Category, Ticker')
    args = parser.parse_args()
    from curl_cffi import requests
    import psycopg2
    from social_worker import DDL, NEWS_INSERT, news_category, news_tickers
    now = datetime.now(timezone.utc)
    since = cutoff_date(now).replace(hour=0, minute=0, second=0, microsecond=0)
    session = requests.Session()

    def fetch(url, **kwargs):
        response = session.get(url, timeout=30, **kwargs)
        if response.status_code != 200:
            raise RuntimeError(f'{args.source}: HTTP {response.status_code}; archive access failed')
        return response

    if args.file:
        batches = file_batches(args.file)
    elif args.source == 'FDA':
        batches = fda_pages(fetch, since, now)
    elif args.source == 'Benzinga':
        batches = benzinga_pages(fetch, since, now, os.getenv('BENZINGA_API_TOKEN', ''))
    else:
        raise RuntimeError('Use --file with an authorized publisher archive export for this source; recent RSS is not a three-month archive')
    total = skipped = 0
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        with conn.cursor() as cur:
            cur.execute(DDL)
        conn.commit()
        for batch in batches:
            with conn.cursor() as cur:
                for record in batch:
                    title = html.unescape(str(record.get('Title') or record.get('headline') or '')).strip()
                    url = str(record.get('Url') or record.get('url') or '').strip()
                    date = date_value(record.get('Date') or record.get('published_at'))
                    parsed = urlparse(url)
                    if not title or not date or not since <= date <= now or parsed.scheme not in ('http', 'https') or not parsed.hostname:
                        skipped += 1
                        continue
                    source = str(record.get('Source') or record.get('source') or args.source)
                    if source != args.source:
                        skipped += 1
                        continue
                    cur.execute(NEWS_INSERT, (title, source, date, url, record.get('Category') or news_category(title), record.get('Ticker') or news_tickers(title)))
                    total += cur.rowcount
            conn.commit()
            print(f'{args.source}: saved {total} new or changed articles; skipped {skipped}', flush=True)
        print(f'Finished available archive pages/export for {since.date()} through {now.date()}; this does not certify publisher completeness.', flush=True)
    finally:
        conn.close()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('Stopped. Committed batches are retained; rerunning deduplicates by URL.', file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        # Never echo request URLs (Benzinga URLs contain the token) or DB exceptions.
        message = str(error) if isinstance(error, RuntimeError) else 'Check connection, dependencies, archive format and private environment settings'
        print(message, file=sys.stderr)
        sys.exit(1)
