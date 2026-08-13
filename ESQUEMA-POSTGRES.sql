-- =====================================================================
-- Registro de Consumos — esquema relacional PostgreSQL
-- Derivado de MODELO-DE-DATOS.md (once hojas de Google Sheets).
--
-- Requiere PostgreSQL 13+ (gen_random_uuid vía pgcrypto).
-- Convención: snake_case, singular en tablas, PK `id`, FK `<tabla>_id`.
--
-- Las siete "deudas del modelo" del documento se resuelven acá:
--   1. sucursal siempre por FK a sucursal.id, nunca por nombre.
--   2. foto tiene PK propia, no posición de fila.
--   3. foto.registro_id enlaza la foto con el registro que produjo.
--   4. subcategoría se guarda como id (FK a catálogo), no como etiqueta.
--   5. unidad se persiste en la fila, no se deriva.
--   6. consumo/costo son numeric NULL-ables: "ilegible" ≠ 0.
--   7. hay columnas de autoría (creado_por, completada_por).
--
-- SOBRE LA AUTENTICACIÓN Y EL TENANT
-- Este esquema se va a injertar en un proyecto que ya tiene usuarios, así
-- que acá NO hay tabla de usuarios: las columnas de autoría son uuid sin
-- FK, a la espera de la tabla del anfitrión. Al integrar, una línea por
-- columna:
--   ALTER TABLE registro_consumo
--     ADD CONSTRAINT registro_consumo_creado_por_fkey
--     FOREIGN KEY (creado_por) REFERENCES <tabla_de_usuarios> (id);
-- Lo mismo aplica a `empresa`: si el anfitrión ya tiene organizaciones o
-- tenants, `empresa` es esa tabla y sobra la de acá.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- Dominios y tipos
-- ---------------------------------------------------------------------

-- Período mensual "YYYY-MM", igual que en la planilla.
CREATE DOMAIN periodo_mes AS char(7)
  CHECK (VALUE ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

CREATE TYPE tipo_consumo AS ENUM (
  'electricidad', 'combustible', 'agua', 'refrigerantes'
);

CREATE TYPE unidad_medida AS ENUM (
  'kWh', 'L', 'gal', 'm3', 'kg', 't'
);

CREATE TYPE registro_estado AS ENUM ('activa', 'eliminada');

-- 'sheets' = fila preexistente (columna Origen vacía en la planilla).
CREATE TYPE registro_origen AS ENUM ('manual', 'documento', 'foto', 'sheets');

CREATE TYPE foto_status AS ENUM ('pendiente', 'procesado');

CREATE TYPE adjunto_rol AS ENUM ('factura', 'pago', 'respaldo');

CREATE TYPE subcategoria_origen AS ENUM ('predef', 'custom');

-- 'auto' usa las emisiones ya registradas del año base; 'manual', el número
-- que se escribió a mano (seedEmissions en lib/domain/emisiones.js).
CREATE TYPE meta_base_mode AS ENUM ('manual', 'auto');

CREATE TYPE drive_carpeta_rol AS ENUM (
  'fotos_por_completar', 'fotos_procesados',
  'manual_facturas', 'upload_facturas',
  'medidor_facturas', 'medidor_pagos', 'medidor_respaldos',
  'proveedor_por_procesar', 'proveedor_procesados'
);

-- ---------------------------------------------------------------------
-- Utilidad: updated_at
-- ---------------------------------------------------------------------

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- 1. Instancia y personas
-- =====================================================================

-- La columna `Empresa` de las hojas era un discriminante de instancia
-- (constante EMPRESA en lib/instance.js). Acá es una fila.
CREATE TABLE empresa (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo      text NOT NULL,            -- 'NEXT'
  nombre      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT empresa_codigo_key UNIQUE (codigo)
);

CREATE TRIGGER empresa_set_updated_at BEFORE UPDATE ON empresa
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- No hay tabla de usuarios: la trae el proyecto anfitrión. Las columnas
-- `creado_por` / `completada_por` de más abajo son uuid sin FK, y quedan
-- NULL en todo lo que se migre desde la planilla (deuda 7: la planilla no
-- registra quién escribió cada fila, y eso no es recuperable).

-- =====================================================================
-- 2. Catálogos (hoy viven en código: lib/domain/catalog.js, emisiones.js)
-- =====================================================================

CREATE TABLE proveedor (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL,
  nombre        text NOT NULL,
  tipo_consumo  tipo_consumo NOT NULL,
  CONSTRAINT proveedor_tipo_slug_key UNIQUE (tipo_consumo, slug)
);

-- Subcategorías: las predefinidas del catálogo y las que crea el usuario
-- (id 'otro:<slug>'), en la misma tabla. Reemplaza a las etiquetas con
-- emoji y a las heurísticas de texto (combSubcatFromLabel).
CREATE TABLE subcategoria (
  id             text PRIMARY KEY,        -- 'diesel', 'potable', 'otro:aceite-usado'
  tipo_consumo   tipo_consumo NOT NULL,
  label          text NOT NULL,
  origen         subcategoria_origen NOT NULL DEFAULT 'predef',
  unidad_default unidad_medida NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subcategoria_tipo_consumo_idx ON subcategoria (tipo_consumo);

-- Unidades admitidas por subcategoría (FUEL_SUBCATS_CATALOG.units).
-- Es la restricción que falta hoy: un combustible en galones se guardaba
-- como litros.
CREATE TABLE subcategoria_unidad (
  subcategoria_id text NOT NULL REFERENCES subcategoria (id) ON DELETE CASCADE,
  unidad          unidad_medida NOT NULL,
  PRIMARY KEY (subcategoria_id, unidad)
);

-- Factores de emisión: etiqueta, alcance, unidad y fuente son catálogo;
-- solo el número es dato de la instancia (ver factor_empresa/_sucursal).
-- Las claves del catálogo son las mismas que `subcat` del registro para
-- combustible ('diesel', 'glp'…) y el propio tipo para electricidad y agua.
-- Eso es lo que permite ir de un consumo a su factor con un JOIN.
CREATE TABLE factor_emision (
  id              text PRIMARY KEY,     -- 'diesel', 'electricidad', 'agua'
  label           text NOT NULL,
  unidad          text NOT NULL,        -- 'kgCO₂e/kWh', 'kgCO₂e/L', …
  alcance         smallint NOT NULL CHECK (alcance IN (1, 2, 3)),
  tipo_consumo    tipo_consumo NOT NULL,
  subcategoria_id text REFERENCES subcategoria (id) ON DELETE SET NULL,
  fuente          text NOT NULL         -- 'IPCC 2006 · Huella Chile'
);

CREATE INDEX factor_emision_subcategoria_idx ON factor_emision (subcategoria_id);

CREATE TABLE refrigerante_gas (
  id       text PRIMARY KEY,            -- 'r410a'
  label    text NOT NULL,
  gwp_ar5  numeric(10, 2) NOT NULL CHECK (gwp_ar5 >= 0)
);

-- =====================================================================
-- 3. Sucursales y su configuración  (hoja `Config Sucursales`)
-- =====================================================================

CREATE TABLE sucursal (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  nombre      text NOT NULL,
  direccion   text,
  activa      boolean NOT NULL DEFAULT true,
  legacy_id   text,                      -- `Sucursal ID` de la planilla
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Deuda 1: el nombre era clave de hecho y mutable. Acá es único y
  -- declarado, y renombrar ya no arrastra filas de datos.
  CONSTRAINT sucursal_empresa_nombre_key UNIQUE (empresa_id, nombre),
  CONSTRAINT sucursal_legacy_id_key      UNIQUE (legacy_id)
);

CREATE INDEX sucursal_empresa_id_idx ON sucursal (empresa_id);
CREATE INDEX sucursal_activa_idx     ON sucursal (empresa_id) WHERE activa;

CREATE TRIGGER sucursal_set_updated_at BEFORE UPDATE ON sucursal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- El aplanado de `Config Sucursales`: una fila por subcategoría de una
-- sucursal. Sin la fila-base vacía: una sucursal sin subcategorías
-- simplemente no tiene filas acá.
CREATE TABLE sucursal_subcategoria (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id       uuid NOT NULL REFERENCES sucursal (id) ON DELETE CASCADE,
  tipo_consumo      tipo_consumo NOT NULL,
  subcategoria_id   text REFERENCES subcategoria (id) ON DELETE RESTRICT,
  proveedor_id      uuid REFERENCES proveedor (id) ON DELETE SET NULL,
  unidad            unidad_medida,
  num_cliente       text,
  sistema_electrico text,               -- solo electricidad (SIC/SING…)
  uso               text,
  activa            boolean NOT NULL DEFAULT true,
  legacy_id         text,               -- `Subcat ID` de la planilla ('sc0', …)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Dos índices en vez de un UNIQUE de tres columnas: en Postgres los NULL
-- son distintos entre sí, y electricidad configura tipos sin subcategoría.
CREATE UNIQUE INDEX sucursal_subcategoria_key
  ON sucursal_subcategoria (sucursal_id, tipo_consumo, subcategoria_id)
  WHERE subcategoria_id IS NOT NULL;
CREATE UNIQUE INDEX sucursal_subcategoria_sin_subcat_key
  ON sucursal_subcategoria (sucursal_id, tipo_consumo)
  WHERE subcategoria_id IS NULL;

CREATE INDEX sucursal_subcategoria_sucursal_idx
  ON sucursal_subcategoria (sucursal_id, tipo_consumo);
CREATE INDEX sucursal_subcategoria_proveedor_idx
  ON sucursal_subcategoria (proveedor_id);
CREATE INDEX sucursal_subcategoria_num_cliente_idx
  ON sucursal_subcategoria (num_cliente) WHERE num_cliente IS NOT NULL;

CREATE TRIGGER sucursal_subcategoria_set_updated_at
  BEFORE UPDATE ON sucursal_subcategoria
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 4. Archivos de Drive  (columnas Link / File ID, hoy repetidas)
-- =====================================================================

CREATE TABLE archivo_drive (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drive_file_id  text NOT NULL,
  url            text,
  nombre         text,
  mime_type      text,
  subido_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT archivo_drive_file_id_key UNIQUE (drive_file_id)
);

-- El mapa `driveFolders` de la hoja `Config`, normalizado.
-- Los roles por tipo llevan tipo_consumo; los de proveedor, proveedor_id.
CREATE TABLE drive_carpeta (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  rol           drive_carpeta_rol NOT NULL,
  tipo_consumo  tipo_consumo,
  proveedor_id  uuid REFERENCES proveedor (id) ON DELETE CASCADE,
  folder_id     text NOT NULL,
  CONSTRAINT drive_carpeta_discriminante_chk CHECK (
    (rol = 'medidor_respaldos'      AND tipo_consumo IS NOT NULL AND proveedor_id IS NULL)
    OR (rol IN ('proveedor_por_procesar', 'proveedor_procesados')
                                    AND proveedor_id IS NOT NULL AND tipo_consumo IS NULL)
    OR (rol NOT IN ('medidor_respaldos', 'proveedor_por_procesar', 'proveedor_procesados')
                                    AND tipo_consumo IS NULL AND proveedor_id IS NULL)
  )
);

-- Un rol simple es único por empresa; los de tipo, por tipo; los de
-- proveedor, por proveedor. Partidos por la misma razón que arriba.
CREATE UNIQUE INDEX drive_carpeta_rol_key
  ON drive_carpeta (empresa_id, rol)
  WHERE tipo_consumo IS NULL AND proveedor_id IS NULL;
CREATE UNIQUE INDEX drive_carpeta_rol_tipo_key
  ON drive_carpeta (empresa_id, rol, tipo_consumo)
  WHERE tipo_consumo IS NOT NULL;
CREATE UNIQUE INDEX drive_carpeta_rol_proveedor_key
  ON drive_carpeta (empresa_id, rol, proveedor_id)
  WHERE proveedor_id IS NOT NULL;

-- =====================================================================
-- 5. Registros de consumo
--    Una tabla en vez de tres hojas (Combustible / Electricidad / Agua),
--    que es lo que la app ya hacía al leer (readRecords).
-- =====================================================================

CREATE TABLE registro_consumo (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  sucursal_id     uuid NOT NULL REFERENCES sucursal (id) ON DELETE RESTRICT,
  tipo_consumo    tipo_consumo NOT NULL,
  subcategoria_id text REFERENCES subcategoria (id) ON DELETE RESTRICT,
  proveedor_id    uuid REFERENCES proveedor (id) ON DELETE SET NULL,
  num_cliente     text,
  fecha           date NOT NULL,
  -- Deuda 6: NULL = ilegible o no informado. 0 es un cero de verdad.
  consumo         numeric(14, 3) CHECK (consumo >= 0),
  unidad          unidad_medida NOT NULL,   -- deuda 5: se guarda
  costo           numeric(14, 2) CHECK (costo >= 0),
  estado          registro_estado NOT NULL DEFAULT 'activa',
  origen          registro_origen NOT NULL DEFAULT 'manual',
  archivo_id      uuid REFERENCES archivo_drive (id) ON DELETE SET NULL,
  creado_por      uuid,                     -- usuario del anfitrión; sin FK todavía
  legacy_id       text,                     -- 'comb_lz3k_7a1b', 'comb-12'
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registro_consumo_legacy_id_key UNIQUE (legacy_id),
  -- refrigerantes no tiene hoja de registros y sigue sin tenerla acá.
  CONSTRAINT registro_consumo_tipo_chk
    CHECK (tipo_consumo <> 'refrigerantes')
);

-- Lectura principal del dashboard: sucursal × tipo × rango de fechas,
-- descartando las eliminadas.
CREATE INDEX registro_consumo_sucursal_tipo_fecha_idx
  ON registro_consumo (sucursal_id, tipo_consumo, fecha DESC)
  WHERE estado = 'activa';
CREATE INDEX registro_consumo_empresa_fecha_idx
  ON registro_consumo (empresa_id, fecha DESC);
CREATE INDEX registro_consumo_subcategoria_idx ON registro_consumo (subcategoria_id);
CREATE INDEX registro_consumo_proveedor_idx    ON registro_consumo (proveedor_id);
CREATE INDEX registro_consumo_archivo_idx      ON registro_consumo (archivo_id);
CREATE INDEX registro_consumo_origen_idx       ON registro_consumo (origen);

CREATE TRIGGER registro_consumo_set_updated_at BEFORE UPDATE ON registro_consumo
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 6. Módulo Medidores  (hojas Medidores / Lecturas Medidor / Precios Medidor)
-- =====================================================================

CREATE TABLE medidor (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id  uuid NOT NULL REFERENCES sucursal (id) ON DELETE CASCADE,
  tipo_consumo tipo_consumo NOT NULL,
  nombre       text NOT NULL,
  numero       text,
  activo       boolean NOT NULL DEFAULT true,
  facturable   boolean NOT NULL DEFAULT true,   -- vacío se leía como sí
  legacy_id    text,                            -- 'med_lz3k_7'
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medidor_legacy_id_key UNIQUE (legacy_id),
  CONSTRAINT medidor_sucursal_numero_key UNIQUE (sucursal_id, tipo_consumo, numero)
);

CREATE INDEX medidor_sucursal_tipo_idx ON medidor (sucursal_id, tipo_consumo);
CREATE INDEX medidor_facturable_idx    ON medidor (sucursal_id) WHERE facturable AND activo;

CREATE TRIGGER medidor_set_updated_at BEFORE UPDATE ON medidor
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- La clave real de la hoja era (Medidor ID, Período); acá es un UNIQUE.
-- `lectura` es NULL cuando la fila existe solo por sus adjuntos.
CREATE TABLE lectura_medidor (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medidor_id  uuid NOT NULL REFERENCES medidor (id) ON DELETE CASCADE,
  periodo     periodo_mes NOT NULL,
  lectura     numeric(14, 3) CHECK (lectura >= 0),
  creado_por  uuid,                          -- usuario del anfitrión; sin FK todavía
  legacy_id   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lectura_medidor_key UNIQUE (medidor_id, periodo)
);

CREATE INDEX lectura_medidor_periodo_idx ON lectura_medidor (periodo);

CREATE TRIGGER lectura_medidor_set_updated_at BEFORE UPDATE ON lectura_medidor
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Los tres tríos de columnas (Factura/Pago/Respaldo × Link/Nombre/File ID)
-- pasan a ser filas. El UNIQUE mantiene "a lo más uno de cada rol".
CREATE TABLE lectura_adjunto (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lectura_medidor_id uuid NOT NULL REFERENCES lectura_medidor (id) ON DELETE CASCADE,
  rol                adjunto_rol NOT NULL,
  archivo_id         uuid NOT NULL REFERENCES archivo_drive (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lectura_adjunto_rol_key UNIQUE (lectura_medidor_id, rol)
);

CREATE INDEX lectura_adjunto_archivo_idx ON lectura_adjunto (archivo_id);

-- Tarifa por (sucursal, tipo, mes) — decisión de producto: compartida
-- entre los medidores de la sucursal, no una por medidor.
CREATE TABLE precio_periodo (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id  uuid NOT NULL REFERENCES sucursal (id) ON DELETE CASCADE,
  tipo_consumo tipo_consumo NOT NULL,
  periodo      periodo_mes NOT NULL,
  precio       numeric(14, 4) NOT NULL CHECK (precio >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT precio_periodo_key UNIQUE (sucursal_id, tipo_consumo, periodo)
);

CREATE INDEX precio_periodo_periodo_idx ON precio_periodo (periodo, tipo_consumo);

CREATE TRIGGER precio_periodo_set_updated_at BEFORE UPDATE ON precio_periodo
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 7. Emisiones — la hoja de 7 columnas con `Scope` se parte en cinco tablas
-- =====================================================================

CREATE TABLE factor_emision_empresa (
  empresa_id       uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  factor_emision_id text NOT NULL REFERENCES factor_emision (id) ON DELETE RESTRICT,
  valor            numeric(16, 6) NOT NULL CHECK (valor >= 0),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, factor_emision_id)
);

CREATE TRIGGER factor_emision_empresa_set_updated_at
  BEFORE UPDATE ON factor_emision_empresa
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Override de sucursal: lo que no está acá se hereda de la empresa.
CREATE TABLE factor_emision_sucursal (
  sucursal_id       uuid NOT NULL REFERENCES sucursal (id) ON DELETE CASCADE,
  factor_emision_id text NOT NULL REFERENCES factor_emision (id) ON DELETE RESTRICT,
  valor             numeric(16, 6) NOT NULL CHECK (valor >= 0),
  pending_review    boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sucursal_id, factor_emision_id)
);

CREATE INDEX factor_emision_sucursal_pending_idx
  ON factor_emision_sucursal (sucursal_id) WHERE pending_review;

CREATE TRIGGER factor_emision_sucursal_set_updated_at
  BEFORE UPDATE ON factor_emision_sucursal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cargas de refrigerante. El `uid` de la planilla no era estable entre
-- guardados; acá la PK es de la base y el reemplazo por grupo deja de
-- ser necesario.
CREATE TABLE refrigerante_carga (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id         uuid NOT NULL REFERENCES sucursal (id) ON DELETE CASCADE,
  refrigerante_gas_id text NOT NULL REFERENCES refrigerante_gas (id) ON DELETE RESTRICT,
  periodo             periodo_mes NOT NULL,
  carga_kg            numeric(12, 3) NOT NULL CHECK (carga_kg >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refrigerante_carga_sucursal_periodo_idx
  ON refrigerante_carga (sucursal_id, periodo);
CREATE INDEX refrigerante_carga_gas_idx ON refrigerante_carga (refrigerante_gas_id);

CREATE TRIGGER refrigerante_carga_set_updated_at
  BEFORE UPDATE ON refrigerante_carga
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- META_FIELDS deja de ser key/value: cinco columnas, una fila por entidad.
CREATE TABLE meta_empresa (
  empresa_id      uuid PRIMARY KEY REFERENCES empresa (id) ON DELETE CASCADE,
  absoluta        numeric(16, 4),
  relativa        numeric(16, 4),
  anio_base       smallint CHECK (anio_base BETWEEN 1990 AND 2200),
  base_emissions  numeric(16, 4),
  base_mode       meta_base_mode,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER meta_empresa_set_updated_at BEFORE UPDATE ON meta_empresa
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE meta_sucursal (
  sucursal_id     uuid PRIMARY KEY REFERENCES sucursal (id) ON DELETE CASCADE,
  absoluta        numeric(16, 4),
  relativa        numeric(16, 4),
  anio_base       smallint CHECK (anio_base BETWEEN 1990 AND 2200),
  base_emissions  numeric(16, 4),
  base_mode       meta_base_mode,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER meta_sucursal_set_updated_at BEFORE UPDATE ON meta_sucursal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 8. Fotos — cola de trabajo
-- =====================================================================

CREATE TABLE foto (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  archivo_id        uuid NOT NULL REFERENCES archivo_drive (id) ON DELETE RESTRICT,
  sucursal_id       uuid REFERENCES sucursal (id) ON DELETE SET NULL,
  tipo_consumo      tipo_consumo,
  subcategoria_id   text REFERENCES subcategoria (id) ON DELETE SET NULL,
  periodo           periodo_mes,
  status            foto_status NOT NULL DEFAULT 'pendiente',
  consumo           numeric(14, 3) CHECK (consumo >= 0),
  unidad            unidad_medida,
  costo             numeric(14, 2) CHECK (costo >= 0),
  proveedor_id      uuid REFERENCES proveedor (id) ON DELETE SET NULL,
  notas             text,
  -- Deuda 3: el registro que produjo esta foto, navegable y único.
  registro_id       uuid REFERENCES registro_consumo (id) ON DELETE SET NULL,
  subida_at         timestamptz NOT NULL DEFAULT now(),
  completada_at     timestamptz,
  completada_por    uuid,                    -- usuario del anfitrión; sin FK todavía
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT foto_archivo_key  UNIQUE (archivo_id),
  CONSTRAINT foto_registro_key UNIQUE (registro_id),
  -- procesado ⇒ tiene registro y fecha de cierre. Esto es lo que hoy
  -- ninguna restricción sostiene, y por eso completeFoto podía correr dos veces.
  CONSTRAINT foto_procesado_chk CHECK (
    status <> 'procesado'
    OR (registro_id IS NOT NULL AND completada_at IS NOT NULL)
  )
);

-- La cola: lo primero que se consulta son las pendientes, por antigüedad.
CREATE INDEX foto_pendiente_idx ON foto (empresa_id, subida_at)
  WHERE status = 'pendiente';
CREATE INDEX foto_sucursal_periodo_idx ON foto (sucursal_id, periodo);

CREATE TRIGGER foto_set_updated_at BEFORE UPDATE ON foto
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE foto_notif_email (
  empresa_id  uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  email       text NOT NULL,
  PRIMARY KEY (empresa_id, email)
);

-- =====================================================================
-- 9. Config key/value — lo que queda de la hoja `Config`
--    driveFolders y fotoNotifEmails ya tienen tabla; esto es el resto.
-- =====================================================================

CREATE TABLE app_config (
  empresa_id  uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  clave       text NOT NULL,
  valor       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, clave)
);

CREATE TRIGGER app_config_set_updated_at BEFORE UPDATE ON app_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
