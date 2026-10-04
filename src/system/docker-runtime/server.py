"""HAP managed inference adapter. Health means weights are loaded, not just an open port."""
import base64
import io
import os
import tempfile
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel, Field

MODEL_ID = os.environ['MODEL_ID']
MODEL_REPO = os.environ['MODEL_REPO']
ENGINE = os.environ['MODEL_ENGINE']
app = FastAPI(title='HAP local inference')
state = {'phase': 'loading', 'error': ''}
lock = threading.Lock()
pipe = None
processor = None
jobs = {}
jobs_lock = threading.Lock()
executor = ThreadPoolExecutor(max_workers=1)


def load_model():
    global pipe, processor
    try:
        import torch
        from huggingface_hub import snapshot_download
        print(f'Downloading {MODEL_REPO}', flush=True)
        if ENGINE == 'cosyvoice':
            path = snapshot_download(MODEL_REPO)
            from cosyvoice.cli.cosyvoice import CosyVoice
            pipe = CosyVoice(path, load_jit=False, load_trt=False, fp16=False)
        elif ENGINE in ('whisper', 'qwen-audio'):
            from transformers import pipeline, AutoProcessor, Qwen2AudioForConditionalGeneration
            if ENGINE == 'whisper':
                pipe = pipeline('automatic-speech-recognition', model=MODEL_REPO,
                                torch_dtype=torch.float32, device=-1, chunk_length_s=30)
            else:
                if not torch.cuda.is_available():
                    raise RuntimeError('NVIDIA CUDA GPU is required')
                processor = AutoProcessor.from_pretrained(MODEL_REPO)
                pipe = Qwen2AudioForConditionalGeneration.from_pretrained(
                    MODEL_REPO, torch_dtype=torch.float16, device_map='auto')
        else:
            if not torch.cuda.is_available():
                raise RuntimeError('NVIDIA CUDA GPU is required')
            from diffusers import FluxPipeline, StableDiffusion3Pipeline, AutoPipelineForText2Image, CogVideoXPipeline, HunyuanVideoPipeline
            cls = {'flux': FluxPipeline, 'sd3': StableDiffusion3Pipeline,
                   'sdxl': AutoPipelineForText2Image, 'cogvideo': CogVideoXPipeline,
                   'hunyuan': HunyuanVideoPipeline}[ENGINE]
            dtype = torch.bfloat16 if ENGINE in ('flux', 'cogvideo') else torch.float16
            kwargs = {'variant': 'fp16'} if ENGINE == 'sdxl' else {}
            if ENGINE == 'hunyuan':
                from diffusers import HunyuanVideoTransformer3DModel
                kwargs['transformer'] = HunyuanVideoTransformer3DModel.from_pretrained(
                    MODEL_REPO, subfolder='transformer', torch_dtype=torch.bfloat16)
            pipe = cls.from_pretrained(MODEL_REPO, torch_dtype=dtype, **kwargs)
            pipe.enable_model_cpu_offload()
            if hasattr(pipe, 'vae'):
                pipe.vae.enable_tiling()
        state['phase'] = 'ready'
        print(f'Ready: {MODEL_ID}', flush=True)
    except Exception as exc:
        state.update(phase='error', error=str(exc))
        traceback.print_exc()


@app.on_event('startup')
def startup():
    threading.Thread(target=load_model, daemon=True).start()


@app.get('/health')
def health():
    return JSONResponse({**state, 'model': MODEL_ID}, status_code=200 if state['phase'] == 'ready' else 503)


def ready(engine_set, model=None):
    if state['phase'] != 'ready':
        raise HTTPException(503, state['error'] or 'Model is loading')
    if ENGINE not in engine_set:
        raise HTTPException(400, 'This model does not support this endpoint')
    if model and model != MODEL_ID:
        raise HTTPException(404, f'Model must be {MODEL_ID}')


@app.get('/v1/models')
def models():
    ready({ENGINE})
    return {'object': 'list', 'data': [{'id': MODEL_ID, 'object': 'model', 'owned_by': 'local'}]}


@app.post('/v1/audio/transcriptions')
def transcribe(file: UploadFile = File(...), model: str = Form(...)):
    ready({'whisper', 'qwen-audio'}, model)
    import librosa
    import numpy as np
    import subprocess
    payload = file.file.read(50 * 1024 * 1024 + 1)
    if len(payload) > 50 * 1024 * 1024:
        raise HTTPException(413, 'Audio exceeds 50 MB')
    with tempfile.TemporaryDirectory() as folder:
        src, dst = Path(folder) / 'input', Path(folder) / 'audio.wav'
        src.write_bytes(payload)
        try:
            subprocess.run(['ffmpeg', '-v', 'error', '-i', str(src), '-ar', '16000', '-ac', '1', str(dst)], check=True, capture_output=True, timeout=120)
        except Exception as exc:
            raise HTTPException(400, 'Invalid audio or decoding timed out') from exc
        audio, _ = librosa.load(str(dst), sr=16000)
    if audio.size > 16000 * 600:
        raise HTTPException(400, 'Audio must be at most 10 minutes')
    with lock:
        if ENGINE == 'whisper':
            text = pipe({'raw': np.asarray(audio), 'sampling_rate': 16000})['text']
        else:
            prompt = '<|im_start|>user\n<|audio_bos|><|AUDIO|><|audio_eos|>Transcribe this audio.<|im_end|>\n<|im_start|>assistant\n'
            inputs = processor(text=prompt, audios=[audio], sampling_rate=16000, return_tensors='pt', padding=True).to(pipe.device)
            output = pipe.generate(**inputs, max_new_tokens=1024)
            text = processor.batch_decode(output[:, inputs.input_ids.size(1):], skip_special_tokens=True)[0]
    return {'text': text.strip()}


class SpeechInput(BaseModel):
    model: str = MODEL_ID
    input: str = Field(min_length=1, max_length=3000)
    reference_audio: str = Field(min_length=1, max_length=20 * 1024 * 1024)
    reference_text: str = Field(min_length=1, max_length=3000)
    response_format: str = 'wav'


@app.post('/v1/audio/speech')
def speech(data: SpeechInput):
    ready({'cosyvoice'}, data.model)
    if data.response_format != 'wav':
        raise HTTPException(400, 'Only wav output is supported')
    import torch
    import soundfile as sf
    with tempfile.TemporaryDirectory() as folder:
        ref = Path(folder) / 'reference.wav'
        try:
            ref.write_bytes(base64.b64decode(data.reference_audio, validate=True))
        except ValueError as exc:
            raise HTTPException(400, 'reference_audio must be base64 audio') from exc
        with lock:
            chunks = [chunk['tts_speech'].cpu() for chunk in pipe.inference_zero_shot(data.input, data.reference_text, str(ref), stream=False)]
        output = io.BytesIO()
        sf.write(output, torch.cat(chunks, dim=1).squeeze().numpy(), pipe.sample_rate, format='WAV')
    return Response(output.getvalue(), media_type='audio/wav')


class GenerationInput(BaseModel):
    model: str = MODEL_ID
    prompt: str = Field(min_length=1, max_length=5000)
    n: int = Field(default=1, ge=1, le=1)
    size: str = '512x512'
    response_format: str = 'b64_json'


@app.post('/v1/images/generations')
def generate_image(data: GenerationInput):
    ready({'flux', 'sd3', 'sdxl'}, data.model)
    if data.response_format != 'b64_json':
        raise HTTPException(400, 'Use response_format=b64_json')
    if data.size not in ('512x512', '768x768', '1024x1024'):
        raise HTTPException(400, 'Supported sizes: 512x512, 768x768, 1024x1024')
    width, height = map(int, data.size.split('x'))
    params = {'prompt': data.prompt, 'width': width, 'height': height}
    if ENGINE == 'flux':
        params.update(num_inference_steps=4, guidance_scale=0.0, max_sequence_length=256)
    elif ENGINE == 'sdxl':
        params.update(num_inference_steps=1, guidance_scale=0.0)
    else:
        params.update(num_inference_steps=28, guidance_scale=4.5)
    with lock:
        image = pipe(**params).images[0]
    output = io.BytesIO()
    image.save(output, format='PNG')
    return {'created': int(time.time()), 'data': [{'b64_json': base64.b64encode(output.getvalue()).decode()}]}


def video_job(job_id, prompt):
    try:
        from diffusers.utils import export_to_video
        with jobs_lock:
            jobs[job_id]['status'] = 'in_progress'
        with lock:
            params = {'prompt': prompt, 'num_frames': 49, 'num_inference_steps': 30}
            if ENGINE == 'hunyuan':
                params.update(height=480, width=832, guidance_scale=6.0)
            else:
                params.update(height=480, width=720, guidance_scale=6.0)
            frames = pipe(**params).frames[0]
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'video.mp4')
            export_to_video(frames, path, fps=8)
            payload = Path(path).read_bytes()
        with jobs_lock:
            jobs[job_id].update(status='completed', payload=payload)
    except Exception as exc:
        with jobs_lock:
            jobs[job_id].update(status='failed', error=str(exc))
        traceback.print_exc()


@app.post('/v1/videos/generations')
def generate_video(data: GenerationInput):
    ready({'cogvideo', 'hunyuan'}, data.model)
    with jobs_lock:
        if any(j['status'] in ('queued', 'in_progress') for j in jobs.values()):
            raise HTTPException(409, 'A video generation is already running')
        if len(jobs) >= 3:
            del jobs[next(iter(jobs))]
        job_id = uuid4().hex
        jobs[job_id] = {'id': job_id, 'status': 'queued'}
    executor.submit(video_job, job_id, data.prompt)
    return {'id': job_id, 'status': 'queued'}


@app.get('/v1/videos/{job_id}')
def video_status(job_id: str):
    with jobs_lock:
        if job_id not in jobs:
            raise HTTPException(404, 'Unknown or expired video')
        return {k: v for k, v in jobs[job_id].items() if k != 'payload'}


@app.get('/v1/videos/{job_id}/content')
def video_content(job_id: str):
    with jobs_lock:
        if job_id not in jobs:
            raise HTTPException(404, 'Unknown or expired video')
        if jobs[job_id]['status'] != 'completed':
            raise HTTPException(409, 'Video not ready')
        return Response(jobs[job_id]['payload'], media_type='video/mp4')


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=8000)
