# Docker multimodal deployment implementation plan

Goal: manage all nine external models with real Docker inference services and register only healthy deployments.
Architecture: static recipes + Docker CLI manager + packaged Python FastAPI adapter + existing GUI IPC. Runtime downloads are user initiated; unit tests use injected Docker transport.

- [x] Recipe tests: all nine catalog IDs, valid runtime repos, CPU/GPU constraints, loopback binding and named volume isolation.
- [x] Manager tests: Docker unavailable, insufficient RAM/architecture, progress, health before registration, stop/remove, duplicate deployment and timeout errors.
- [x] Implement recipes and Docker manager under src/system/docker-models.ts and src/system/docker-deployment.ts.
- [x] Implement packaged inference adapter under src/system/docker-runtime, with separate CosyVoice environment and shared Transformers/Diffusers environment; health only after actual model load.
- [x] Connect service, IPC/preload and model hub controls; register category-specific capabilities; show logs and gated-repository token input.
- [x] Verify Python syntax, targeted tests, lint, full tests and build. Test Docker prerequisite checks on this host; report separately any inference not verified without GPU/model weights.

Validation note: standard ARM64 image built successfully; eight runtime classes imported in Docker; four Python API smoke tests passed. A Whisper base download and loading-state check was exercised, then the temporary test container/cache were removed. Full model inference and the dedicated CosyVoice GPU image are not validated on this ARM host with 4 GB Docker RAM and no NVIDIA GPU.
