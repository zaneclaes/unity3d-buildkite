# Docker (https://docs.docker.com/install/linux/docker-ce/ubuntu/)
RUN curl -fsSL https://download.docker.com/linux/debian/gpg | apt-key add -
RUN add-apt-repository \
   "deb [arch=amd64] https://download.docker.com/linux/ubuntu \
   $(lsb_release -cs) \
   stable"
RUN apt-get -y update && apt-get -y install docker-ce docker-ce-cli containerd.io
