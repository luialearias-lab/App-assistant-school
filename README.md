# 🎓 Asistencia Escolar QR

Aplicación web para colegios que permite:

- **Tomar asistencia con código QR**: cada alumno tiene un carné con QR; el profesor lo escanea con la cámara del celular/tablet/PC o con un lector USB.
- **Notificar a los padres por WhatsApp**: pasado un tiempo configurable desde el inicio de la clase, la lista se cierra sola, los alumnos que no registraron asistencia quedan con **falta** y se envía un WhatsApp a los padres de los **ausentes** y de los que **llegaron tarde**.
- **Organización por grado, sección y curso** (ej. *1ro Secundaria → Sección A → Matemática*).
- **Récord mensual por alumno** (calendario, totales, % de asistencia, detalle por curso) y por sección (matriz exportable a Excel/CSV e imprimible).
- **Tareas y comentarios**: el profesor envía tareas o comentarios a un grado, una sección, un curso o a alumnos seleccionados; opcionalmente también por WhatsApp a los padres.
- **Portal para padres y alumnos** (sin contraseña, con código personal) donde ven su asistencia del mes, tareas y comentarios.
- 100 % **web** y adaptada a celulares.

## Cómo funciona la asistencia

Cada curso tiene:

| Campo | Ejemplo | Significado |
|---|---|---|
| Hora de inicio | 08:00 | Inicio de la clase |
| Tolerancia | 10 min | Hasta las 08:10 se registra **Presente**; después, **Tarde** |
| Notificar tras | 30 min | A las 08:30 la lista se cierra: los no registrados quedan con **Falta** y se envía el WhatsApp a los padres de faltas y tardanzas |

1. El profesor entra a **Tomar asistencia** (o desde el *Panel del día*) y abre la lista del curso.
2. Escanea el QR de cada alumno. Se muestra y suena la confirmación (Presente/Tarde).
3. Al llegar la hora de notificación, el servidor cierra la lista automáticamente y envía los WhatsApp. También puede cerrarla antes con **“Cerrar y notificar a padres”**.
4. Si un alumno llega después del cierre, al escanearlo pasa de *Falta* a *Tarde* y se avisa a los padres al instante.
5. El profesor puede corregir manualmente el estado (P/T/F/J) y **justificar** faltas con un motivo.

> Solo se procesan las listas que el profesor abrió ese día: si un curso no tuvo clase, no se envía nada.

## Requisitos

- **Node.js 22.13 o superior** (usa el SQLite integrado de Node, no requiere base de datos externa).

## Instalación rápida

```bash
npm install
npm run seed      # opcional: datos de demostración
npm start         # http://localhost:3000
```

Usuarios de demostración (después de `npm run seed`):

| Rol | Correo | Contraseña |
|---|---|---|
| Administrador | admin@colegio.edu | admin123 |
| Docente | maria@colegio.edu | docente123 |
| Docente | carlos@colegio.edu | docente123 |

Sin `seed`, al iniciar por primera vez se crea el administrador definido en `ADMIN_EMAIL` / `ADMIN_PASSWORD` (por defecto `admin@colegio.edu` / `admin123`). **Cambie la contraseña** en *Mi cuenta*.

### Con Docker

```bash
docker build -t asistencia-qr .
docker run -d -p 3000:3000 -v asistencia-data:/app/data --env-file .env asistencia-qr
```

## Configuración

Copie `.env.example` a `.env` y ajuste los valores (se carga automáticamente con `npm start`).

Desde el menú **Configuración** (administrador) se define el nombre del colegio, la **zona horaria** (ej. `America/Lima`, `America/Bogota`, `America/Mexico_City`), la URL pública y el texto de los mensajes de WhatsApp con variables como `{alumno}`, `{curso}`, `{fecha}`, `{hora_registro}`.

### WhatsApp

Por defecto `WHATSAPP_PROVIDER=simulado`: los mensajes **no se envían**, pero quedan registrados en *Notificaciones WhatsApp* y en la consola, ideal para pruebas.

**Opción 1 – Meta WhatsApp Business Cloud API** (oficial)

```env
WHATSAPP_PROVIDER=meta
WHATSAPP_TOKEN=<token de acceso permanente>
WHATSAPP_PHONE_NUMBER_ID=<id del número>
WHATSAPP_TEMPLATE_NAME=aviso_colegio   # recomendado
WHATSAPP_TEMPLATE_LANG=es
```

WhatsApp exige **plantillas aprobadas** para mensajes que inicia la empresa. Cree en Meta Business una plantilla de categoría *Utilidad* con un único parámetro en el cuerpo, por ejemplo: `{{1}}`. La app envía el texto completo del aviso como ese parámetro.

**Opción 2 – Twilio**

```env
WHATSAPP_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxx
TWILIO_WHATSAPP_FROM=+14155238886
```

Los teléfonos de los apoderados se guardan con código de país (`+51987654321`). Si se ingresan sin prefijo, se usa `WHATSAPP_DEFAULT_COUNTRY_CODE`.

## Puesta en marcha en el colegio

1. **Grados, secciones y cursos**: cree los grados (1ro, 2do…), sus secciones (A, B…) y los cursos de cada sección con su docente y horario.
2. **Usuarios**: cree una cuenta para cada docente.
3. **Alumnos**: regístrelos uno a uno o use **Importar lista** pegando desde Excel las columnas `Apellidos;Nombres;DNI;Apoderado;WhatsApp`.
4. **Carnés QR**: en *Alumnos*, filtre por sección y pulse **Imprimir carnés QR** (tamaño tarjeta de crédito). Cada carné incluye el enlace al portal de padres.
5. Los docentes ingresan desde su celular y toman asistencia.

## Acceso desde la web y la cámara

Los navegadores solo permiten usar la cámara en sitios **HTTPS** (o `localhost`). Para usarla desde celulares publique la app detrás de HTTPS, por ejemplo:

- Un servicio de hosting de Node (Render, Railway, Fly.io, un VPS…) con dominio y certificado.
- Un proxy inverso (Nginx/Caddy) con Let's Encrypt. En ese caso defina `TRUST_PROXY=true`.

Sin HTTPS se puede seguir registrando con un **lector de códigos USB/Bluetooth** (funciona como teclado) o escribiendo el código.

## Roles

- **Administrador**: gestiona todo (estructura, alumnos, usuarios, configuración) y ve todos los cursos.
- **Docente**: toma asistencia en sus cursos, ve el récord de sus secciones y envía tareas/comentarios a sus alumnos.
- **Padres/alumnos**: portal de solo lectura mediante su enlace personal (`/portal.html?c=CODIGO`).

## Estructura del proyecto

```
src/
  server.js        Arranque, admin inicial y programador de notificaciones
  app.js           Express: middlewares y rutas
  db.js            Esquema SQLite y configuración
  attendance.js    Lógica de asistencia (QR, tardanzas, cierre, avisos)
  whatsapp.js      Envío por Meta / Twilio / simulado
  messages.js      Tareas y comentarios
  reports.js       Récord mensual y exportación CSV
  routes/          API REST
public/            Interfaz web (SPA), portal de padres y carnés
scripts/seed.js    Datos de demostración
test/              Pruebas (node --test)
```

## Pruebas

```bash
npm test
```
