FROM python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db

COPY test.sh verify.py /tests/
COPY candidate_runner.py public_test_runner.py /opt/codexa-agent-ab/
COPY baseline/ /opt/pristine-project/
RUN install -d -o 65532 -g 65532 -m 0700 /tmp/codexa-candidate \
    && chown -R root:root /tests /opt/pristine-project /opt/codexa-agent-ab \
    && find /tests -type d -exec chmod 0700 {} + \
    && find /tests -type f -exec chmod 0600 {} + \
    && chmod 0700 /tests/test.sh /tests/verify.py \
    && find /opt/pristine-project -type d -exec chmod 0700 {} + \
    && find /opt/pristine-project -type f -exec chmod 0600 {} + \
    && chmod 0555 /opt/codexa-agent-ab \
    && chmod 0555 /opt/codexa-agent-ab/candidate_runner.py /opt/codexa-agent-ab/public_test_runner.py

WORKDIR /workspace/project
