FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e

ARG CODEXA_VERSION=0.10.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential git python3 ripgrep \
    && npm install --global --prefix /opt/codexa-runtime "@mirnoorata/codexa@${CODEXA_VERSION}" \
    && rm -rf /var/lib/apt/lists/* /root/.npm

COPY project/ /workspace/project/
COPY codexa-mcp-entrypoint.sh /opt/codexa-agent-ab/start-codexa-mcp

RUN chmod 0755 /opt/codexa-agent-ab/start-codexa-mcp \
    && git -C /workspace/project init --initial-branch=main \
    && git -C /workspace/project config user.name "Agent A/B Fixture" \
    && git -C /workspace/project config user.email "agent-ab@example.invalid" \
    && git -C /workspace/project add --all \
    && git -C /workspace/project commit -m "fixture: initial task state"

WORKDIR /workspace/project
