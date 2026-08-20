import next from "eslint-config-next/core-web-vitals";

// `next lint` ya no existe en Next 16: el lint pasa a ser eslint directo.
// eslint-config-next 16 ya viene en formato flat config, así que se importa tal
// cual — no hace falta FlatCompat.
//
// `_legacy/` queda fuera a propósito: es el prototipo viejo, JSX suelto en tags
// <script> con los componentes como globales del navegador. eslint lo lee como
// módulos y canta ~900 "no está definido" que no son errores de nada. No es
// código que se ejecute, y no se toca. Lo mismo `_design_source/` y
// `design-canvas.jsx`: son los wireframes de referencia, no la app.
const config = [
  { ignores: [".next/**", "node_modules/**", "public/**", "_legacy/**", "_design_source/**", "design-canvas.jsx"] },
  ...(Array.isArray(next) ? next : [next]),
];

export default config;
