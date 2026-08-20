# Playbook: agregar un tipo de consumo

Hoy la app maneja tres tipos: **electricidad**, **combustible** y **agua**. Un
cuarto, `refrigerantes`, existe a medias y por eso está fuera de las listas de
configuración (la explicación está en `lib/domain/sucursales.js`, sobre
`ITEM_TYPES`).

Agregar un tipo **no es una línea**: hay 19 archivos con una rama por tipo, más
la base de datos. Este documento existe porque ese número no se adivina, y porque
la última vez que dos de esas listas quedaron desalineadas el resultado fue una
pantalla que ofrecía algo imposible y una foto que se procesaba sin registrar
nada.

Cómo usarlo: primero las preguntas, después la lista. Las respuestas deciden
cuáles de los pasos "según el caso" aplican, y **la pregunta 1 puede terminar la
conversación**: si el tipo no es un consumo periódico, el lugar correcto
probablemente no sea el registro de consumos.

---

## Parte 1 — Las preguntas, antes de tocar nada

**1. ¿Es un consumo periódico o un evento puntual?**
Un consumo es "gasté 640 kWh en abril". Un evento es "recargué 2,5 kg de gas en
el equipo". Los eventos no tienen lectura mensual ni boleta, y forzarlos a la
forma de un consumo es lo que dejó a los refrigerantes a medio camino. Si es un
evento, la respuesta correcta puede ser la pantalla de Impacto, no ésta.

**2. ¿En qué unidad se mide? ¿Una sola o varias?**
Si trae una unidad nueva hay que agregarla al enum `unidad_medida` de la base
(`kWh`, `L`, `gal`, `m3`, `kg`, `t`) y a `CATEGORIA_UNIDAD` en
`lib/domain/dashboard.js:81`, que agrupa por Volumen / Masa / Energía. El
dashboard **no suma unidades distintas**: si el tipo admite varias, dibuja un
bloque por unidad.

**3. ¿Tiene subcategorías?** ¿Predefinidas, o las crea el usuario?
Combustible tiene diez predefinidas; electricidad no tiene ninguna; agua tiene
tres y admite propias. Las que crea el usuario se guardan como `otro:<slug>`.

**4. ¿Tiene proveedor?** ¿Y número de cliente?
El número de cliente solo lo usan electricidad y agua, y es lo que identifica la
boleta.

**5. ¿Tiene costo en pesos?**

**6. ¿Emite CO₂e?** Si sí, hacen falta cuatro datos por subcategoría: el factor,
su unidad (`kgCO₂e/…`), el **alcance** (1 directo, 2 energía comprada, 3
indirecto) y la **fuente** citable. Sin fuente el número no sirve para reportar.

**7. ¿Se mide con medidor?** Si sí, entra al módulo de Medidores, con lecturas
acumuladas y tarifa por sucursal y mes.

**8. ¿Llega una boleta al mes por cliente, o hay varios eventos en el mismo mes?**
Define si el tipo entra al candado contra doble conteo
(`registro_consumo_boleta_mes_key`). Electricidad y agua sí; combustible **no**,
porque se registra por compra y varias cargas al mes son legítimas. Poner el
candado donde no corresponde rechaza datos buenos.

**9. ¿Los documentos van a una carpeta propia de Drive?**

**10. ¿Se puede registrar por foto?**

**11. ¿Hay proveedores con factura en PDF de los que se extraigan datos?**

**12. ¿Necesita un dato exclusivo del tipo?**
Refrigerantes necesita el gas, porque el GWP cambia el cálculo por completo. Eso
es una columna nueva en `registro_consumo`, nullable, con un CHECK que la ate a
su tipo en las dos direcciones.

---

## Parte 2 — La base de datos

El esquema homologado ayuda: **no hay tabla nueva**. Todos los tipos viven en
`registro_consumo`, y las columnas que no aplican quedan NULL.

| Paso | Dónde | Cuándo |
|------|-------|--------|
| Una fila en la tabla `tipo_consumo` (id, label, unidad por defecto, orden) | `ESQUEMA-POSTGRES.sql` §2 Catálogos | Siempre. **Es un INSERT, no una migración** |
| `ALTER TYPE unidad_medida ADD VALUE '<unidad>'` | idem | Si la unidad es nueva (P2) |
| Filas en `subcategoria` y `subcategoria_unidad` | §2 Catálogos | Si tiene subcategorías (P3) |
| Filas en `proveedor` | §2 Catálogos | Si tiene proveedor (P4) |
| Filas en `factor_emision` + valor en `factor_emision_empresa` | §2 y §7 | Si emite (P6) |
| Columna nullable propia + CHECK que la ate al tipo | §5 `registro_consumo` | Si tiene dato exclusivo (P12) |
| Sumar el tipo al índice `registro_consumo_boleta_mes_key` | §5, al final | Solo si es una boleta al mes (P8) |
| `ALTER TYPE drive_carpeta_rol ADD VALUE …` | §Dominios | Si necesita carpeta (P9) |

**RLS no cambia**: las filas viven en `registro_consumo`, que ya tiene su
política de alcance.

Al terminar, `npm run db:check` tiene que seguir en verde, y conviene agregar una
comprobación del tipo nuevo en `scripts/pruebas-alcance.mjs` — sobre todo la del
candado mensual, en el sentido que corresponda.

La unidad **sí** sigue siendo una lista cerrada (`unidad_medida`), y ahí el aviso
vale: agregar un valor a un enum es una línea, pero quitarlo es imposible. Si tu
tipo trae una unidad nueva —"unidades", "rollos"— es el mismo argumento que movió
`tipo_consumo` a tabla, y es la conversión que sigue si empieza a molestar.

---

## Parte 3 — El front y el dominio

### Obligatorio: sin esto el tipo no funciona

| # | Archivo | Qué |
|---|---------|-----|
| 1 | `lib/sheets/records.js` → `LAYOUT` | **El muro real mientras los datos vivan en la planilla:** cada tipo necesita su propia hoja, con su mapa de columnas. Sin entrada en `LAYOUT`, el registro se descarta (`rowsBySheet`: `if (!layout \|\| !row) continue`). Cuando la app pase a Postgres esto desaparece. |
| 2 | `lib/domain/catalog.js` → `TYPES` | Etiqueta, unidad por defecto, icono y color. Es la lista que alimenta el **registro manual** y el dashboard. |
| 3 | `lib/domain/sucursales.js` → `ITEM_TYPES` y `emptyItems` | Los tipos que una sucursal puede configurar. También manda las columnas de la **matriz de carga**. |
| 4 | `lib/sheets/sucursales.js` → su propio `ITEM_TYPES` | La persistencia en la planilla. Está duplicado a propósito: es la capa de datos. |
| 5 | `lib/domain/opciones.js` → `ITEM_DEFS` | Etiqueta, icono y color para configuración y matriz. **Es la lista que quedó desalineada de `TYPES` y causó el problema.** |
| 6 | `components/ui/subcat-form.jsx` | Los campos del formulario de subcategoría, por tipo. |

### Según las respuestas

| Archivo | Qué | Pregunta |
|---------|-----|----------|
| `lib/domain/catalog.js` → `INITIAL_SUBCATS`, `PROVIDERS` | Subcategorías y proveedores iniciales | P3, P4 |
| `lib/domain/emisiones.js` → `EMISSION_FACTOR_CATALOG` | Factor, alcance, unidad, fuente | P6 |
| `lib/domain/emisiones-calc.js` → `byCat` | El tipo en el desglose de emisiones | P6 |
| `lib/domain/dashboard.js` → `CATEGORIA_UNIDAD`, `unidadDeSubcat` | Agrupación por unidad en los gráficos | P2 |
| `lib/domain/matriz.js` → `etiquetaSubcat`, `corresponde` | Cómo se rotula y se cruza la casilla | siempre que entre a la matriz |
| `lib/domain/estado-carga.js` | Rama por tipo del estado de carga | idem |
| `components/views/foto-hub.jsx` → `TIPO_OPCIONES` **y** `lib/sheets/fotos.js:104` | **Los dos, o se pierden datos.** La pantalla ofrece el tipo y la lista blanca de `completeFoto` decide si se escribe el registro. Con uno sin el otro, la foto queda procesada, el archivo se mueve y el consumo no se escribe en ninguna parte, sin error ni aviso. | P10 |
| `lib/domain/medidores-calc.js` | El tipo en el módulo de Medidores | P7 |
| `lib/reportes/medidores-html.js` | Icono y alcance en el reporte | P7 |
| `lib/domain/proveedores.js`, `lib/extractores/index.js`, `lib/google/actions.js` | Proveedores con extractor de PDF | P11 |
| `lib/drive-folders.js` → `medidorRespaldos` | Carpeta de Drive por tipo | P9 |

---

## Parte 4 — Comprobar

En este orden, y ninguno es opcional:

1. `npm test` — los 45 tests del repositorio.
2. `npm run db:check` — el esquema en un Postgres real, con las pruebas de
   aislamiento y de las reglas de la tabla de consumos.
3. `npm run db:supabase` — lo mismo contra el motor de verdad, en un esquema
   desechable.
4. Con la app levantada (`SITE_PASSWORD= npm run dev`), recorrer **las cinco
   pantallas** donde el tipo tiene que aparecer o no aparecer: `/configuracion`,
   `/registrar/manual`, `/registrar/foto`, `/matriz`, `/dashboard`. Que la página
   responda 200 no alcanza: hay que ver que el tipo esté en el menú donde
   corresponde y ausente donde no.
5. Si el tipo emite, comprobar que el dashboard de Impacto lo muestra en su
   alcance (1, 2 o 3) y no lo suma al que no le toca.

## La prueba de que esto está mal diseñado

Que este documento necesite cuatro partes es el síntoma. Un tipo de consumo
debería declararse en **un** lugar y que el resto se derive. Hoy son 19 archivos,
y dos de ellos ya se desalinearon una vez.

Cuando se rediseñe, el criterio: una sola definición por tipo, y que todo lo
demás —formularios, matriz, dashboard, fotos, emisiones— la lea de ahí. Mientras
eso no exista, este playbook es el parche que evita repetir el error.
