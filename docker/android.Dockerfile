ENV DEBIAN_FRONTEND noninteractive
ENV DEBCONF_NONINTERACTIVE_SEEN true

RUN apt-get update -qq; \
    apt-get install -qq -y \
    locales \
    software-properties-common \
    unzip \
    && add-apt-repository ppa:openjdk-r/ppa \
    && add-apt-repository ppa:cwchien/gradle \
    && apt-get install -qq -y \
    gradle \
    openjdk-8-jdk \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8

# Setup Android SDK/JDK Environment Variables
ENV ANDROID_SDK_VERSION ${ANDROID_SDK_VERSION:-28}
ENV ANDROID_SDK_TOOLS_VERSION ${ANDROID_SDK_TOOLS_VERSION:-28.0.3}
ENV ANDROID_SDK_COMPONENTS build-tools;$ANDROID_SDK_TOOLS_VERSION platform-tools platforms;android-$ANDROID_SDK_VERSION
ENV JAVA_HOME /usr/lib/jvm/java-8-openjdk-amd64/jre/
ENV PATH ${PATH}:/usr/lib/jvm/java-8-openjdk-amd64/jre/bin
ENV ANDROID_HOME /opt/android-sdk-linux

ENV PATH ${PATH}:${ANDROID_HOME}/tools:${ANDROID_HOME}/platform-tools
ENV LANG en_US.UTF-8

# Install Android SDK Installer...
RUN cd /opt && \
    wget -q https://dl.google.com/android/repository/sdk-tools-linux-4333796.zip -O android-sdk.zip && \
    unzip -q android-sdk.zip -d android-sdk-linux && \
    rm -f android-sdk.zip && \
    ls -ahl android-sdk-linux

RUN chmod -R 755 .${ANDROID_HOME}/tools/*

# accept license
RUN yes | ${ANDROID_HOME}/tools/bin/sdkmanager --licenses

# Install Android SDK
RUN ${ANDROID_HOME}/tools/bin/sdkmanager ${ANDROID_SDK_COMPONENTS} > /dev/null && \
  ${ANDROID_HOME}/tools/bin/sdkmanager --list

RUN gradle -v
