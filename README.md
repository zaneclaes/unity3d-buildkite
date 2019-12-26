

## Usage

### Kubernetes

```
kc create secret generic unity3d-buildkite \
  --from-literal=BUILDKITE_AGENT_TOKEN=${BUILDKITE_AGENT_TOKEN} \
  --from-literal=AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID} \
  --from-literal=AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY} \
  --from-literal=AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION} \
  -n btd
 ```
