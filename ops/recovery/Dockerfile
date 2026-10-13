FROM postgres:17-bookworm@sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df
RUN apt-get update && apt-get install -y --no-install-recommends awscli age ca-certificates && rm -rf /var/lib/apt/lists/*
COPY ops/recovery/backup.sh ops/recovery/restore.sh /opt/recovery/
ENTRYPOINT ["sh", "/opt/recovery/backup.sh"]
