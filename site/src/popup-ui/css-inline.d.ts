// `?inline` CSS imports return the stylesheet as a string (not auto-injected).
declare module "*.css?inline" {
  const css: string;
  export default css;
}
