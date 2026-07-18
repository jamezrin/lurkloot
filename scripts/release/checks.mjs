export const validationStatusContexts = [
  "verify",
  "extension / build",
  "docker / build (linux/amd64, ubuntu-latest, amd64)",
  "docker / build (linux/arm64, ubuntu-24.04-arm, arm64)",
];

export const candidateStatusContext = "release candidate / ready";

export const requiredMainStatusContexts = [...validationStatusContexts, candidateStatusContext];
