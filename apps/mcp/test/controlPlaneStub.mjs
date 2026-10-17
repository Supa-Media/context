// Facade: this file used to hold the control-plane stub and the S3 backend in
// one module. It is split by responsibility into `controlPlaneStub/`, and
// re-exported here unchanged so every existing import of
// `./controlPlaneStub.mjs` keeps working.
export {
  sha256Hex,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
} from "./controlPlaneStub/controlPlane.mjs";
export { createS3Backend } from "./controlPlaneStub/s3Backend.mjs";
