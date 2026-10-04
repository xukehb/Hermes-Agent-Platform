FROM python:3.10-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN pip install --no-cache-dir torch==2.5.1 torchaudio==2.5.1 transformers==4.51.3 diffusers==0.33.1 accelerate==1.6.0 huggingface-hub==0.30.2 numpy==1.26.4 fastapi==0.115.12 uvicorn==0.34.2 python-multipart==0.0.20 librosa==0.10.2.post1 soundfile==0.13.1 sentencepiece==0.2.0 protobuf==4.25.6 imageio==2.37.0 imageio-ffmpeg==0.6.0
COPY server.py /app/server.py
ENV PYTHONUNBUFFERED=1 HF_HOME=/cache/huggingface
EXPOSE 8000
CMD ["python", "server.py"]
