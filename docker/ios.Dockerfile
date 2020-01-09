ARG BASE_IMAGE
FROM $BASE_IMAGE

# cocoapods, for iOS builds
RUN apt-get install -y ruby-dev
RUN gem install -n /usr/local/bin cocoapods

RUN which cocoapods
