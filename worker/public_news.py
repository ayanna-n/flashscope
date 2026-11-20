"""Public publisher headlines. Uses standard HTTP; no challenge bypass or login."""
import html
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse

HEADERS = {'User-Agent': 'FlashScope news monitor', 'Accept': 'application/rss+xml, text/html;q=0.9'}


def text(value):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', ' ', value or ''))).strip()


def valid_url(value):
    parsed = urlparse(value)
    return parsed.scheme in ('http', 'https') and bool(parsed.hostname)


def download(url):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=25) as response:
        return response.read().decode('utf-8', errors='replace')


def parse_accesswire(raw):
    rows = []
    for card in re.findall(r'<article\b[^>]*class=["\'][^"\']*\bnr-card\b[^"\']*["\'][^>]*>[\s\S]*?</article>', raw, re.I):
        heading = re.search(r'<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>[\s\S]*?</h2>', card, re.I)
        meta = re.search(r'<p\b[^>]*class=["\'][^"\']*\bnr-card-meta\b[^"\']*["\'][^>]*>([\s\S]*?)</p>', card, re.I)
        if not heading or not meta:
            continue
        match = re.match(r'([A-Za-z]+ \d{1,2}, \d{4})', text(meta[1]))
        if not match:
            continue
        try:
            # Publisher does not identify timezone; retain day only, never invent one.
            date = datetime.strptime(match[1], '%B %d, %Y').replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        title, url = text(heading[2]), html.unescape(heading[1])
        if title and valid_url(url):
            rows.append({'title': title, 'url': url, 'date': date})
    return rows


def parse_benzinga(raw):
    root = ET.fromstring(raw)
    rows = []
    for item in root.findall('.//item'):
        title, url = text(item.findtext('title')), (item.findtext('link') or '').strip()
        try:
            date = parsedate_to_datetime(item.findtext('pubDate') or '').astimezone(timezone.utc)
        except (ValueError, TypeError):
            continue
        if title and valid_url(url):
            rows.append({'title': title, 'url': url, 'date': date})
    return rows


def fetch_source(source):
    if source == 'AccessWire':
        return parse_accesswire(download('https://www.accessnewswire.com/newsroom'))
    if source == 'Benzinga':
        return parse_benzinga(download('https://www.benzinga.com/feed'))
    raise ValueError('Unsupported public source')
