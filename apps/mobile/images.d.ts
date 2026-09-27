/** An image import is an asset reference Metro resolves; `<Image source>` takes it as is. */
declare module "*.png" {
  const source: import("react-native").ImageSourcePropType;
  export default source;
}
