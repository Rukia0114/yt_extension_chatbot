FROM python:3.11-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg wget curl \
  && rm -rf /var/lib/apt/lists/*

# Install deno for yt-dlp JS runtime
RUN curl -fsSL https://deno.land/install.sh | sh \
  && echo 'export PATH="/root/.deno/bin:$PATH"' >> /root/.bashrc

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 9000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9000"]
