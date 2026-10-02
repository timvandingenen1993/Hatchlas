/// <reference types="vite/client" />

declare module "*.tif" {
  const src: string;
  export default src;
}

declare module "*.tiff" {
  const src: string;
  export default src;
}
