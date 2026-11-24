# ct-vision: image AI for clean-titles (SigLIP 2 on the GPU; CPU if no GPU). PyTorch from the CUDA 12.8 wheels, the
# first builds with RTX 50 (Blackwell, sm_120) kernels.
FROM python:3.12-slim
ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 HF_HOME=/cache HF_HUB_DISABLE_TELEMETRY=1
RUN pip install --index-url https://download.pytorch.org/whl/cu128 "torch>=2.7" && \
    pip install "transformers>=4.51,<5" "sentencepiece" "protobuf" "pillow>=10" "fastapi>=0.110" "uvicorn>=0.29" "httpx>=0.27"
COPY app.py /app/app.py
WORKDIR /app
EXPOSE 8077
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8077", "--workers", "1", "--log-level", "warning"]
