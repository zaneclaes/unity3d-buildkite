ARG UNITY_TAG

FROM gableroux/unity3d:${UNITY_TAG}

# Dependencies
RUN apt-get -y update && apt-get install -y  \
    apt-transport-https \
    dirmngr \
    ca-certificates \
    curl \
    gnupg2 \
    software-properties-common \
    zip unzip

# Buildkite (https://buildkite.com/docs/agent/v3/debian)
ENV APT_KEY_DONT_WARN_ON_DANGEROUS_USAGE=1
RUN echo "deb https://apt.buildkite.com/buildkite-agent stable main" | tee /etc/apt/sources.list.d/buildkite-agent.list
RUN apt-key adv --keyserver ipv4.pool.sks-keyservers.net --recv-keys 32A37959C2FA5C3C99EFBC32A79206696452D198
RUN apt-get update && apt-get install -y buildkite-agent

# Docker (https://docs.docker.com/install/linux/docker-ce/ubuntu/)
RUN curl -fsSL https://download.docker.com/linux/debian/gpg | apt-key add -
RUN add-apt-repository \
   "deb [arch=amd64] https://download.docker.com/linux/ubuntu \
   $(lsb_release -cs) \
   stable"
RUN apt-get -y update && apt-get -y install docker-ce docker-ce-cli containerd.io

# Ensure Python 3.7
RUN apt-get -y update && apt-get -y upgrade && apt-get install -y python3.7 python3-pip
RUN update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.7 1
RUN pip3 install pyyaml awscli

# CI Scripts
ADD ./bin /bin
RUN chmod +x /bin/ci/make.py
RUN mkdir -p /root/.cache/unity3d

CMD ["buildkite-agent", "start"]
