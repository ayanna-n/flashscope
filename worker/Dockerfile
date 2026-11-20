FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY worker/requirements.txt /app/worker/requirements.txt
RUN pip install -r /app/worker/requirements.txt
COPY worker/ /app/worker/
CMD ["python", "-u", "worker/social_worker.py"]
