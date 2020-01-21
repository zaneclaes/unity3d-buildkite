ARG COMPONENTS=Unity

ENV DEBIAN_FRONTEND noninteractive
ENV DEBCONF_NONINTERACTIVE_SEEN true

RUN wget -nv ${DOWNLOAD_URL} -O UnitySetup && \
    # compare sha1 if given
    if [ -n "${SHA1}" -a "${SHA1}" != "" ]; then \
      echo "${SHA1}  UnitySetup" | sha1sum --check -; \
    else \
      echo "no sha1 given, skipping checksum"; \
    fi && \
    # make executable
    chmod +x UnitySetup && \
    # agree with license
    echo y | \
    # install unity with required components
    ./UnitySetup \
    --unattended \
    --install-location=/opt/Unity \
    --verbose \
    --download-location=/tmp/unity \
    --components=$COMPONENTS && \
    # remove setup & temp files
    rm UnitySetup && \
    rm -rf /tmp/unity && \
    rm -rf /root/.local/share/Trash/*

# Ensure Python 3.7
RUN apt-get -y update && apt-get -y upgrade && apt-get install -y python3.7 python3-pip
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.7 1
RUN pip3 install pyyaml awscli

# Allow the buildkite-agent user to run Unity
RUN chown -R buildkite-agent:buildkite-agent /opt/Unity

# CI Scripts
ADD ./bin /bin
RUN chmod +x /bin/ci/make.py
RUN chmod +x /bin/ci/agent.sh
RUN mkdir -p /root/.cache/unity3d

# Docker entrypoint
RUN mkdir -p /etc/buildkite-agent/hooks
COPY ./agent-hooks /etc/buildkite-agent/hooks
RUN chmod -R +x /etc/buildkite-agent/hooks

WORKDIR /var/lib/buildkite-agent
RUN mkdir -p /var/lib/buildkite-agent/.config && \
  chown buildkite-agent:buildkite-agent /var/lib/buildkite-agent/.config
RUN mkdir -p /var/lib/buildkite-agent/.local/share/unity3d/Unity && \
  chown buildkite-agent:buildkite-agent /var/lib/buildkite-agent/.local

CMD ["buildkite-agent", "start"]
