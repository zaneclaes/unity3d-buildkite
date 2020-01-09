FROM inzania/headless_unity

ARG PROJECT_NAME
ARG RUN_FLAGS="-batchmode -nographics -logfile /dev/stdout"

RUN echo "#!/bin/bash" > /usr/local/bin/docker-entrypoint.sh && \
  echo "/usr/local/bin/${PROJECT_NAME} ${RUN_FLAGS}" >> /usr/local/bin/docker-entrypoint.sh && \
  chmod +x /usr/local/bin/docker-entrypoint.sh

COPY "${PROJECT_NAME}" /usr/local/bin/

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
