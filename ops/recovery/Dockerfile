FROM postgres:18-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c
RUN apt-get update && apt-get install -y --no-install-recommends awscli age ca-certificates && rm -rf /var/lib/apt/lists/*
COPY ops/recovery/backup.sh ops/recovery/restore.sh /opt/recovery/
ENTRYPOINT ["sh", "/opt/recovery/backup.sh"]
