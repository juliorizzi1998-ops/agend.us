require("dotenv").config()

// =====================================================
// ZONA HORARIA
// =====================================================

process.env.TZ = "Europe/Madrid"

// =====================================================
// IMPORTACIONES
// =====================================================

const express = require("express")
const session = require("express-session")
const Database = require("better-sqlite3")
const { google } = require("googleapis")
const crypto = require("crypto")

const app = express()

const db = new Database(process.env.DB_PATH || "fusion-calendarios.db")

const puerto = 3000

// =====================================================
// URL PÚBLICA / LOCAL
// =====================================================

const PUBLIC_BASE_URL = (
    process.env.PUBLIC_BASE_URL ||
    `http://localhost:${puerto}`
).replace(/\/$/, "")

// =====================================================
// GOOGLE
// =====================================================

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET

const GOOGLE_REDIRECT_URI =
    `${PUBLIC_BASE_URL}/auth/google/callback`

const GOOGLE_CALENDAR_REDIRECT_URI =
    `${PUBLIC_BASE_URL}/auth/google/calendar/callback`

const loginOAuth2Client =
    new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI
    )

const calendarOAuth2Client =
    new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        GOOGLE_CALENDAR_REDIRECT_URI
    )

// =====================================================
// NYLAS
// =====================================================

const NYLAS_CLIENT_ID = process.env.NYLAS_CLIENT_ID
const NYLAS_API_KEY = process.env.NYLAS_API_KEY

const NYLAS_CALLBACK_URI =
    process.env.NYLAS_CALLBACK_URI ||
    `${PUBLIC_BASE_URL}/auth/nylas/callback`

const NYLAS_API_BASE =
    process.env.NYLAS_API_BASE ||
    "https://api.eu.nylas.com"

// =====================================================
// EXPRESS
// =====================================================

app.use(express.json())

app.use(
    session({
        secret:
            process.env.SESSION_SECRET ||
            "fusion-calendarios-super-secreto",

        resave: false,

        saveUninitialized: false,

        cookie: {
            httpOnly: true,
            maxAge:
                1000 *
                60 *
                60 *
                24 *
                7
        }
    })
)

// =====================================================
// BASE DE DATOS
// =====================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS grupos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        creador TEXT NOT NULL,
        codigo_invitacion TEXT NOT NULL UNIQUE
    )
`).run()

// =====================================================
// CUENTAS
// =====================================================

let estructuraCuentas =
    db.prepare(`
        PRAGMA table_info(cuentas)
    `).all()

if (estructuraCuentas.length === 0) {

    db.prepare(`
        CREATE TABLE cuentas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT,
            google_id TEXT UNIQUE,
            google_refresh_token TEXT
        )
    `).run()

} else {

    const tienePassword =
        estructuraCuentas.some(
            columna =>
                columna.name === "password_hash"
        )

    const columnaGoogleId =
        estructuraCuentas.find(
            columna =>
                columna.name === "google_id"
        )

    const tieneGoogleRefresh =
        estructuraCuentas.some(
            columna =>
                columna.name === "google_refresh_token"
        )

    if (!tienePassword) {
        db.prepare(`
            ALTER TABLE cuentas
            ADD COLUMN password_hash TEXT
        `).run()
    }

    if (!tieneGoogleRefresh) {
        db.prepare(`
            ALTER TABLE cuentas
            ADD COLUMN google_refresh_token TEXT
        `).run()
    }

    if (
        columnaGoogleId &&
        columnaGoogleId.notnull === 1
    ) {

        const migrarCuentas =
            db.transaction(() => {

                db.prepare(`
                    ALTER TABLE cuentas
                    RENAME TO cuentas_antigua
                `).run()

                db.prepare(`
                    CREATE TABLE cuentas (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        nombre TEXT NOT NULL,
                        email TEXT NOT NULL UNIQUE,
                        password_hash TEXT,
                        google_id TEXT UNIQUE,
                        google_refresh_token TEXT
                    )
                `).run()

                db.prepare(`
                    INSERT INTO cuentas (
                        id,
                        nombre,
                        email,
                        password_hash,
                        google_id,
                        google_refresh_token
                    )
                    SELECT
                        id,
                        nombre,
                        email,
                        password_hash,
                        google_id,
                        google_refresh_token
                    FROM cuentas_antigua
                `).run()

                db.prepare(`
                    DROP TABLE cuentas_antigua
                `).run()
            })

        migrarCuentas()
    }
}

// =====================================================
// PERFIL / ONBOARDING / PERSONALIZACIÓN
// =====================================================

const columnasCuentaActuales = db.prepare(`PRAGMA table_info(cuentas)`).all()

function asegurarColumnaCuenta(nombre, definicion) {
    if (!columnasCuentaActuales.some(columna => columna.name === nombre)) {
        db.prepare(`ALTER TABLE cuentas ADD COLUMN ${nombre} ${definicion}`).run()
    }
}

asegurarColumnaCuenta("foto_perfil", "TEXT")
asegurarColumnaCuenta("calendario_principal", "TEXT")
asegurarColumnaCuenta("tema", "TEXT")

// =====================================================
// MIEMBROS
// =====================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS miembros_grupo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cuenta_id INTEGER NOT NULL,
        grupo_id INTEGER NOT NULL,
        UNIQUE(cuenta_id, grupo_id)
    )
`).run()

// =====================================================
// CALENDARIOS
// =====================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS calendarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cuenta_id INTEGER NOT NULL,
        proveedor TEXT NOT NULL,
        grant_id TEXT,
        email TEXT,
        conectado INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(cuenta_id, proveedor)
    )
`).run()

// =====================================================
// EVENTOS DE GRUPO / CONSENSO
// =====================================================

db.prepare(`
    CREATE TABLE IF NOT EXISTS eventos_grupo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        grupo_id INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        titulo TEXT NOT NULL,
        inicio TEXT NOT NULL,
        fin TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        creador_cuenta_id INTEGER NOT NULL,
        reemplaza_evento_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        confirmed_at TEXT
    )
`).run()

db.prepare(`
    CREATE TABLE IF NOT EXISTS confirmaciones_evento (
        evento_grupo_id INTEGER NOT NULL,
        cuenta_id INTEGER NOT NULL,
        confirmado INTEGER NOT NULL DEFAULT 1,
        confirmed_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(evento_grupo_id, cuenta_id)
    )
`).run()

db.prepare(`
    CREATE TABLE IF NOT EXISTS escrituras_evento (
        grupo_id INTEGER NOT NULL,
        cuenta_id INTEGER NOT NULL,
        proveedor TEXT NOT NULL,
        evento_externo_id TEXT,
        calendar_id TEXT,
        enlace TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(grupo_id, cuenta_id)
    )
`).run()

// =====================================================
// MIGRAR GOOGLE
// =====================================================

try {

    const cuentasAntiguas =
        db.prepare(`
            SELECT
                id,
                email,
                google_refresh_token
            FROM cuentas
            WHERE google_refresh_token IS NOT NULL
        `).all()

    for (const cuenta of cuentasAntiguas) {

        db.prepare(`
            INSERT OR IGNORE INTO calendarios (
                cuenta_id,
                proveedor,
                grant_id,
                email,
                conectado
            )
            VALUES (?, 'google', NULL, ?, 1)
        `).run(
            cuenta.id,
            cuenta.email
        )
    }

} catch (error) {

    console.log(
        "No fue necesaria migración Google:",
        error.message
    )
}

// =====================================================
// PÁGINA
// =====================================================

app.get("/", (req, res) => {

    res.sendFile(
        __dirname + "/index.html"
    )

})

// =====================================================
// UTILIDADES
// =====================================================

function generarCodigo() {

    /*
     * Evitamos caracteres visualmente ambiguos
     * (I, O, 0, 1) para que dictar/copiar el código
     * sea mucho más fiable. Los códigos antiguos
     * siguen siendo aceptados al unirse.
     */
    const caracteres =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

    let codigo = ""

    for (let i = 0; i < 6; i++) {

        codigo +=
            caracteres[
                Math.floor(
                    Math.random() *
                    caracteres.length
                )
            ]
    }

    return codigo
}

function hashPassword(password) {

    const salt =
        crypto
            .randomBytes(16)
            .toString("hex")

    const hash =
        crypto
            .scryptSync(
                password,
                salt,
                64
            )
            .toString("hex")

    return `${salt}:${hash}`
}

function comprobarPassword(
    password,
    passwordHash
) {

    if (!passwordHash) return false

    const partes =
        passwordHash.split(":")

    if (partes.length !== 2) return false

    const hash =
        crypto
            .scryptSync(
                password,
                partes[0],
                64
            )
            .toString("hex")

    const a = Buffer.from(hash, "hex")
    const b = Buffer.from(partes[1], "hex")

    if (a.length !== b.length) return false

    return crypto.timingSafeEqual(a, b)
}

// =====================================================
// REGISTRO
// =====================================================

function registrarCuenta(req, res) {

    try {

        const nombre =
            String(
                req.body.nombre || ""
            ).trim()

        const email =
            String(
                req.body.email || ""
            )
                .trim()
                .toLowerCase()

        const password =
            String(
                req.body.password || ""
            )

        if (!nombre || !email || !password) {

            return res.status(400).json({
                error:
                    "Nombre, email y contraseña son obligatorios."
            })
        }

        if (password.length < 8) {

            return res.status(400).json({
                error:
                    "La contraseña debe tener al menos 8 caracteres."
            })
        }

        const existente =
            db.prepare(`
                SELECT id
                FROM cuentas
                WHERE email = ?
            `).get(email)

        if (existente) {

            return res.status(409).json({
                error:
                    "Ya existe una cuenta con ese email."
            })
        }

        const resultado =
            db.prepare(`
                INSERT INTO cuentas (
                    nombre,
                    email,
                    password_hash
                )
                VALUES (?, ?, ?)
            `).run(
                nombre,
                email,
                hashPassword(password)
            )

        req.session.cuentaId =
            resultado.lastInsertRowid

        req.session.email =
            email

        req.session.save(error => {

            if (error) {

                return res.status(500).json({
                    error:
                        "La cuenta se creó, pero no se pudo iniciar la sesión."
                })
            }

            res.json({
                ok: true,
                cuenta: {
                    id: resultado.lastInsertRowid,
                    nombre,
                    email
                }
            })
        })

    } catch (error) {

        console.error(
            "Error registrando cuenta:",
            error
        )

        res.status(500).json({
            error:
                "No se pudo crear la cuenta."
        })
    }
}

app.post(
    "/auth/register",
    registrarCuenta
)

app.post(
    "/registro",
    registrarCuenta
)

// =====================================================
// LOGIN
// =====================================================

function iniciarSesion(req, res) {

    try {

        const email =
            String(
                req.body.email || ""
            )
                .trim()
                .toLowerCase()

        const password =
            String(
                req.body.password || ""
            )

        const cuenta =
            db.prepare(`
                SELECT *
                FROM cuentas
                WHERE email = ?
            `).get(email)

        if (
            !cuenta ||
            !comprobarPassword(
                password,
                cuenta.password_hash
            )
        ) {

            return res.status(401).json({
                error:
                    "Email o contraseña incorrectos."
            })
        }

        req.session.cuentaId =
            cuenta.id

        req.session.email =
            cuenta.email

        req.session.save(error => {

            if (error) {

                return res.status(500).json({
                    error:
                        "No se pudo guardar la sesión."
                })
            }

            res.json({
                ok: true,
                cuenta: {
                    id: cuenta.id,
                    nombre: cuenta.nombre,
                    email: cuenta.email
                }
            })
        })

    } catch (error) {

        console.error(
            "Error login:",
            error
        )

        res.status(500).json({
            error:
                "No se pudo iniciar sesión."
        })
    }
}

app.post(
    "/auth/login",
    iniciarSesion
)

app.post(
    "/login",
    iniciarSesion
)

// =====================================================
// GOOGLE LOGIN
// =====================================================

app.get(
    "/auth/google",
    (req, res) => {

        const url =
            loginOAuth2Client.generateAuthUrl({

                access_type: "offline",

                prompt: "select_account",

                scope: [
                    "openid",
                    "email",
                    "profile"
                ]
            })

        res.redirect(url)
    }
)

app.get(
    "/auth/google/callback",
    async (req, res) => {

        try {

            if (!req.query.code) {

                return res.status(400).send(
                    "Google no ha enviado el código de autorización."
                )
            }

            const { tokens } =
                await loginOAuth2Client.getToken(
                    req.query.code
                )

            loginOAuth2Client.setCredentials(tokens)

            const oauth2 =
                google.oauth2({
                    auth: loginOAuth2Client,
                    version: "v2"
                })

            const { data } =
                await oauth2.userinfo.get()

            const googleId = data.id
            const email = data.email
            const nombre =
                data.name ||
                email.split("@")[0]

            let cuenta =
                db.prepare(`
                    SELECT *
                    FROM cuentas
                    WHERE google_id = ?
                `).get(googleId)

            if (!cuenta) {

                cuenta =
                    db.prepare(`
                        SELECT *
                        FROM cuentas
                        WHERE email = ?
                    `).get(email)
            }

            if (!cuenta) {

                const resultado =
                    db.prepare(`
                        INSERT INTO cuentas (
                            nombre,
                            email,
                            google_id
                        )
                        VALUES (?, ?, ?)
                    `).run(
                        nombre,
                        email,
                        googleId
                    )

                cuenta =
                    db.prepare(`
                        SELECT *
                        FROM cuentas
                        WHERE id = ?
                    `).get(
                        resultado.lastInsertRowid
                    )

            } else {

                db.prepare(`
                    UPDATE cuentas
                    SET
                        google_id = ?,
                        nombre = ?
                    WHERE id = ?
                `).run(
                    googleId,
                    nombre,
                    cuenta.id
                )
            }

            req.session.cuentaId =
                cuenta.id

            req.session.email =
                cuenta.email

            req.session.save(error => {

                if (error) {

                    return res.status(500).send(
                        "No se pudo guardar la sesión."
                    )
                }

                res.redirect("/?login=google")
            })

        } catch (error) {

            console.error(
                "Error Google:",
                error
            )

            res.status(500).send(
                "Error durante la autenticación con Google."
            )
        }
    }
)

// =====================================================
// GOOGLE CALENDAR
// =====================================================

app.get(
    "/auth/google/calendar",
    (req, res) => {

        if (!req.session.cuentaId) {

            return res.status(401).send(
                "Primero inicia sesión."
            )
        }

        const state =
            crypto
                .randomBytes(32)
                .toString("hex")

        req.session.googleCalendarState =
            state

        const url =
            calendarOAuth2Client.generateAuthUrl({

                access_type: "offline",

                prompt: "consent",

                scope: [
                    "https://www.googleapis.com/auth/calendar.events"
                ],

                state
            })

        req.session.save(error => {

            if (error) {

                return res.status(500).send(
                    "No se pudo guardar la sesión."
                )
            }

            res.redirect(url)
        })
    }
)

app.get(
    "/auth/google/calendar/callback",
    async (req, res) => {

        try {

            if (req.query.error) {

                return res.status(400).send(
                    `Google canceló o rechazó la conexión: ${
                        req.query.error_description ||
                        req.query.error
                    }`
                )
            }

            if (
                !req.query.code ||
                req.query.state !==
                req.session.googleCalendarState
            ) {

                return res.status(400).send(
                    "La sesión de conexión con Google Calendar no es válida."
                )
            }

            delete req.session.googleCalendarState

            const cuentaId =
                Number(
                    req.session.cuentaId
                )

            if (!cuentaId) {

                return res.status(401).send(
                    "La sesión ha expirado."
                )
            }

            const { tokens } =
                await calendarOAuth2Client.getToken(
                    req.query.code
                )

            if (!tokens.refresh_token) {

                return res.status(400).send(
                    "Google no ha enviado un refresh token. Vuelve a intentar conectar Google Calendar."
                )
            }

            db.prepare(`
                UPDATE cuentas
                SET google_refresh_token = ?,
                    calendario_principal = 'google'
                WHERE id = ?
            `).run(
                tokens.refresh_token,
                cuentaId
            )

            db.prepare(`
                INSERT INTO calendarios (
                    cuenta_id,
                    proveedor,
                    email,
                    conectado
                )
                VALUES (?, 'google', NULL, 1)

                ON CONFLICT(cuenta_id, proveedor)
                DO UPDATE SET
                    conectado = 1
            `).run(cuentaId)

            req.session.save(error => {

                if (error) {

                    return res.status(500).send(
                        "Google Calendar se conectó, pero no se pudo guardar la sesión."
                    )
                }

                res.redirect(
                    "/?calendar=google-connected"
                )
            })

        } catch (error) {

            console.error(
                "ERROR GOOGLE CALENDAR:",
                error
            )

            res.status(500).send(
                "Error conectando Google Calendar: " +
                error.message
            )
        }
    }
)

// =====================================================
// ICLOUD / NYLAS
// =====================================================

function conectarIcloud(req, res) {

    if (!req.session.cuentaId) {

        return res.status(401).send(
            "Primero inicia sesión."
        )
    }

    const state =
        crypto
            .randomBytes(32)
            .toString("hex")

    req.session.nylasState =
        state

    const parametros =
        new URLSearchParams({

            client_id:
                NYLAS_CLIENT_ID,

            redirect_uri:
                NYLAS_CALLBACK_URI,

            response_type:
                "code",

            provider:
                "icloud",

            access_type:
                "offline",

            state
        })

    const url =
        `${NYLAS_API_BASE}/v3/connect/auth?${parametros.toString()}`

    req.session.save(error => {

        if (error) {

            return res.status(500).send(
                "No se pudo guardar la sesión."
            )
        }

        res.redirect(url)
    })
}

app.get(
    "/auth/icloud",
    conectarIcloud
)

app.get(
    "/auth/nylas/icloud",
    conectarIcloud
)

app.get(
    "/auth/nylas/callback",
    async (req, res) => {

        try {

            if (req.query.error) {

                return res.status(400).send(
                    `iCloud canceló o rechazó la conexión: ${
                        req.query.error_description ||
                        req.query.error
                    }`
                )
            }

            if (
                !req.query.code ||
                req.query.state !==
                req.session.nylasState
            ) {

                return res.status(400).send(
                    "La sesión de conexión con iCloud no es válida."
                )
            }

            delete req.session.nylasState

            if (!req.session.cuentaId) {

                return res.status(401).send(
                    "La sesión ha expirado."
                )
            }

            const respuesta =
                await fetch(
                    `${NYLAS_API_BASE}/v3/connect/token`,
                    {

                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body:
                            JSON.stringify({

                                client_id:
                                    NYLAS_CLIENT_ID,

                                client_secret:
                                    NYLAS_API_KEY,

                                grant_type:
                                    "authorization_code",

                                code:
                                    req.query.code,

                                redirect_uri:
                                    NYLAS_CALLBACK_URI
                            })
                    }
                )

            const datos =
                await respuesta.json()

            if (!respuesta.ok) {

                throw new Error(
                    datos?.error?.message ||
                    datos?.message ||
                    "Nylas no pudo completar la conexión."
                )
            }

            if (!datos.grant_id) {

                throw new Error(
                    "Nylas no devolvió grant_id."
                )
            }

            db.prepare(`
                INSERT INTO calendarios (
                    cuenta_id,
                    proveedor,
                    grant_id,
                    email,
                    conectado
                )
                VALUES (?, ?, ?, ?, 1)

                ON CONFLICT(cuenta_id, proveedor)
                DO UPDATE SET
                    grant_id = excluded.grant_id,
                    email = excluded.email,
                    conectado = 1
            `).run(
                req.session.cuentaId,
                datos.provider || "icloud",
                datos.grant_id,
                datos.email || null
            )

            db.prepare(`
                UPDATE cuentas
                SET calendario_principal = 'icloud'
                WHERE id = ?
            `).run(req.session.cuentaId)

            req.session.save(error => {

                if (error) {

                    return res.status(500).send(
                        "iCloud se conectó, pero no se pudo guardar la sesión."
                    )
                }

                res.redirect(
                    "/?calendar=icloud-connected"
                )
            })

        } catch (error) {

            console.error(
                "ERROR CALLBACK NYLAS:",
                error
            )

            res.status(500).send(
                "Error conectando iCloud: " +
                error.message
            )
        }
    }
)

// =====================================================
// CUENTA / CALENDARIOS
// =====================================================

app.get(
    "/mi-cuenta",
    (req, res) => {

        if (!req.session.cuentaId) {

            return res.status(401).json({
                error:
                    "No has iniciado sesión."
            })
        }

        const cuenta =
            db.prepare(`
                SELECT
                    id,
                    nombre,
                    email,
                    google_id,
                    foto_perfil,
                    calendario_principal,
                    tema
                FROM cuentas
                WHERE id = ?
            `).get(
                req.session.cuentaId
            )

        if (!cuenta) {

            return res.status(404).json({
                error:
                    "Cuenta no encontrada."
            })
        }

        const calendarios =
            db.prepare(`
                SELECT
                    id,
                    proveedor,
                    email,
                    conectado
                FROM calendarios
                WHERE cuenta_id = ?
                AND conectado = 1
            `).all(cuenta.id)

        const grupos =
            db.prepare(`
                SELECT
                    grupos.id,
                    grupos.nombre,
                    grupos.codigo_invitacion
                FROM grupos
                INNER JOIN miembros_grupo
                    ON grupos.id =
                       miembros_grupo.grupo_id
                WHERE miembros_grupo.cuenta_id = ?
                ORDER BY grupos.id DESC
            `).all(cuenta.id)

        res.json({
            cuenta,
            calendarios,
            grupos
        })
    }
)

app.patch(
    "/mi-cuenta",
    (req, res) => {
        if (!req.session.cuentaId) {
            return res.status(401).json({ error: "No has iniciado sesión." })
        }

        const actual = db.prepare(`SELECT * FROM cuentas WHERE id = ?`).get(req.session.cuentaId)
        if (!actual) return res.status(404).json({ error: "Cuenta no encontrada." })

        const nombre = req.body.nombre !== undefined
            ? String(req.body.nombre || "").trim()
            : actual.nombre
        const foto = req.body.foto_perfil !== undefined
            ? String(req.body.foto_perfil || "")
            : actual.foto_perfil
        const tema = req.body.tema !== undefined
            ? String(req.body.tema || "minimalista")
            : (actual.tema || "minimalista")

        const temasValidos = new Set(["romantica", "minimalista", "mochilera", "dosmilera"])
        if (!nombre) return res.status(400).json({ error: "El nombre no puede estar vacío." })
        if (!temasValidos.has(tema)) return res.status(400).json({ error: "Ese estilo de agenda no existe." })
        if (foto && (!foto.startsWith("data:image/") || foto.length > 1500000)) {
            return res.status(400).json({ error: "La foto de perfil no es válida o pesa demasiado." })
        }

        db.prepare(`
            UPDATE cuentas
            SET nombre = ?, foto_perfil = ?, tema = ?
            WHERE id = ?
        `).run(nombre, foto || null, tema, req.session.cuentaId)

        res.json({ ok: true, cuenta: { ...actual, nombre, foto_perfil: foto || null, tema } })
    }
)

app.get(
    "/cuenta",
    (req, res) => {

        res.redirect("/mi-cuenta")
    }
)

app.get(
    "/calendar/conectados",
    (req, res) => {

        if (!req.session.cuentaId) {

            return res.status(401).json({
                error:
                    "Primero inicia sesión."
            })
        }

        const calendarios =
            db.prepare(`
                SELECT
                    id,
                    proveedor,
                    email,
                    conectado,
                    created_at
                FROM calendarios
                WHERE cuenta_id = ?
                AND conectado = 1
                ORDER BY proveedor
            `).all(
                req.session.cuentaId
            )

        res.json(calendarios)
    }
)

app.get(
    "/mis-calendarios",
    (req, res) => {

        res.redirect("/calendar/conectados")
    }
)

// =====================================================
// NYLAS
// =====================================================

async function nylasFetch(
    url,
    opciones = {}
) {

    const respuesta =
        await fetch(
            url,
            {

                ...opciones,

                headers: {

                    Accept:
                        "application/json",

                    Authorization:
                        `Bearer ${NYLAS_API_KEY}`,

                    ...(opciones.headers || {})
                }
            }
        )

    let datos = null

    try {
        datos = await respuesta.json()
    } catch {
        datos = null
    }

    if (!respuesta.ok) {

        throw new Error(
            datos?.error?.message ||
            datos?.message ||
            `Nylas respondió con HTTP ${respuesta.status}`
        )
    }

    return datos
}

async function obtenerCalendariosNylas(
    grantId
) {

    const calendarios = []

    let pageToken = null

    do {

        const parametros =
            new URLSearchParams()

        if (pageToken) {

            parametros.set(
                "page_token",
                pageToken
            )
        }

        const url =
            `${NYLAS_API_BASE}/v3/grants/${encodeURIComponent(grantId)}/calendars` +
            (
                parametros.toString()
                    ? `?${parametros}`
                    : ""
            )

        const datos =
            await nylasFetch(url)

        calendarios.push(
            ...(Array.isArray(datos.data)
                ? datos.data
                : [])
        )

        pageToken =
            datos.next_cursor ||
            datos.next_page_token ||
            null

    } while (pageToken)

    return calendarios
}

function convertirFechaNylas(when) {

    if (!when) return null

    if (
        when.start_time !== undefined
    ) {

        return new Date(
            Number(when.start_time) * 1000
        ).toISOString()
    }

    if (when.start_date) {

        return when.start_date
    }

    return null
}

function convertirFinNylas(when) {

    if (!when) return null

    if (
        when.end_time !== undefined
    ) {

        return new Date(
            Number(when.end_time) * 1000
        ).toISOString()
    }

    if (when.end_date) {

        return when.end_date
    }

    return null
}

async function obtenerEventosNylas(
    grantId,
    desde,
    hasta,
    provider
) {

    const calendarios =
        await obtenerCalendariosNylas(
            grantId
        )

    const eventosTotales = []

    for (const calendario of calendarios) {

        if (!calendario.id) continue

        let pageToken = null

        do {

            const parametros =
                new URLSearchParams({

                    calendar_id:
                        String(calendario.id),

                    start:
                        String(
                            Math.floor(
                                desde.getTime() / 1000
                            )
                        ),

                    end:
                        String(
                            Math.floor(
                                hasta.getTime() / 1000
                            )
                        ),

                    limit: "200",

                    expand_recurring: "true"
                })

            if (pageToken) {

                parametros.set(
                    "page_token",
                    pageToken
                )
            }

            const datos =
                await nylasFetch(
                    `${NYLAS_API_BASE}/v3/grants/${encodeURIComponent(grantId)}/events?${parametros}`
                )

            for (
                const evento
                of Array.isArray(datos.data)
                    ? datos.data
                    : []
            ) {

                eventosTotales.push({

                    id:
                        evento.id,

                    titulo:
                        evento.title ||
                        "Sin título",

                    inicio:
                        convertirFechaNylas(
                            evento.when
                        ),

                    fin:
                        convertirFinNylas(
                            evento.when
                        ),

                    proveedor:
                        provider,

                    calendario:
                        calendario.name ||
                        null
                })
            }

            pageToken =
                datos.next_cursor ||
                datos.next_page_token ||
                null

        } while (pageToken)
    }

    return eventosTotales
}

// =====================================================
// GOOGLE
// =====================================================

function crearGoogleCalendarClient(
    refreshToken
) {

    const client =
        new google.auth.OAuth2(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            GOOGLE_CALENDAR_REDIRECT_URI
        )

    client.setCredentials({
        refresh_token:
            refreshToken
    })

    return client
}

async function obtenerEventosGoogle(
    refreshToken,
    desde,
    hasta
) {

    const calendarClient =
        crearGoogleCalendarClient(
            refreshToken
        )

    const calendar =
        google.calendar({
            version: "v3",
            auth: calendarClient
        })

    const respuesta =
        await calendar.events.list({

            calendarId: "primary",

            timeMin:
                desde.toISOString(),

            timeMax:
                hasta.toISOString(),

            maxResults: 2500,

            singleEvents: true,

            orderBy: "startTime"
        })

    return respuesta.data.items || []
}

async function crearEventoGoogle(
    refreshToken,
    inicio,
    fin,
    titulo,
    descripcion = ""
) {

    const calendarClient =
        crearGoogleCalendarClient(
            refreshToken
        )

    const calendar =
        google.calendar({
            version: "v3",
            auth: calendarClient
        })

    const respuesta =
        await calendar.events.insert({

            calendarId: "primary",

            requestBody: {

                summary:
                    titulo,

                description:
                    descripcion,

                start: {
                    dateTime: inicio,
                    timeZone:
                        "Europe/Madrid"
                },

                end: {
                    dateTime: fin,
                    timeZone:
                        "Europe/Madrid"
                }
            }
        })

    return {
        id:
            respuesta.data.id,

        enlace:
            respuesta.data.htmlLink || null
    }
}

// =====================================================
// ICLOUD CREAR EVENTO
// =====================================================

async function crearEventoIcloud(
    grantId,
    inicio,
    fin,
    titulo,
    descripcion = ""
) {

    const calendarios =
        await obtenerCalendariosNylas(
            grantId
        )

    let calendario =
        calendarios.find(
            item =>
                item.is_primary &&
                !item.read_only
        )

    if (!calendario) {

        calendario =
            calendarios.find(
                item =>
                    !item.read_only
            )
    }

    if (!calendario) {

        throw new Error(
            "No existe ningún calendario de iCloud donde se pueda escribir."
        )
    }

    const respuesta =
        await fetch(
            `${NYLAS_API_BASE}/v3/grants/${encodeURIComponent(grantId)}/events?calendar_id=${encodeURIComponent(calendario.id)}`,
            {

                method: "POST",

                headers: {

                    Accept:
                        "application/json",

                    Authorization:
                        `Bearer ${NYLAS_API_KEY}`,

                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify({

                        title:
                            titulo,

                        description:
                            descripcion,

                        busy: true,

                        when: {

                            start_time:
                                Math.floor(
                                    new Date(inicio).getTime() /
                                    1000
                                ),

                            end_time:
                                Math.floor(
                                    new Date(fin).getTime() /
                                    1000
                                )
                        }
                    })
            }
        )

    const datos =
        await respuesta.json()

    if (!respuesta.ok) {

        throw new Error(
            datos?.error?.message ||
            datos?.message ||
            "No se pudo crear el evento en iCloud."
        )
    }

    return {

        id:
            datos?.data?.id ||
            datos?.id ||
            null,

        enlace:
            datos?.data?.html_link ||
            datos?.data?.web_url ||
            null,

        calendario:
            calendario.name || null,

        calendar_id:
            calendario.id || null
    }
}

// =====================================================
// TODOS LOS EVENTOS
// =====================================================

app.get(
    "/calendar/todos-eventos",
    async (req, res) => {

        try {

            if (!req.session.cuentaId) {

                return res.status(401).json({
                    error:
                        "Primero inicia sesión."
                })
            }

            const cuenta =
                db.prepare(`
                    SELECT *
                    FROM cuentas
                    WHERE id = ?
                `).get(
                    req.session.cuentaId
                )

            const desde =
                req.query.desde
                    ? new Date(req.query.desde)
                    : new Date()

            const hasta =
                req.query.hasta
                    ? new Date(req.query.hasta)
                    : new Date(
                        desde.getTime() +
                        7 * 24 * 60 * 60 * 1000
                    )

            const eventos = []

            if (
                cuenta &&
                cuenta.google_refresh_token
            ) {

                try {

                    const googleEventos =
                        await obtenerEventosGoogle(
                            cuenta.google_refresh_token,
                            desde,
                            hasta
                        )

                    eventos.push(
                        ...googleEventos.map(
                            evento => ({
                                id: evento.id,
                                titulo:
                                    evento.summary ||
                                    "Sin título",
                                inicio:
                                    evento.start?.dateTime ||
                                    evento.start?.date ||
                                    null,
                                fin:
                                    evento.end?.dateTime ||
                                    evento.end?.date ||
                                    null,
                                proveedor: "google"
                            })
                        )
                    )

                } catch (error) {

                    console.error(
                        "Error Google:",
                        error.message
                    )
                }
            }

            const conexiones =
                db.prepare(`
                    SELECT *
                    FROM calendarios
                    WHERE cuenta_id = ?
                    AND grant_id IS NOT NULL
                    AND conectado = 1
                `).all(
                    req.session.cuentaId
                )

            for (const conexion of conexiones) {

                try {

                    eventos.push(
                        ...await obtenerEventosNylas(
                            conexion.grant_id,
                            desde,
                            hasta,
                            conexion.proveedor
                        )
                    )

                } catch (error) {

                    console.error(
                        "Error Nylas:",
                        error.message
                    )
                }
            }

            eventos.sort(
                (a, b) =>
                    new Date(a.inicio) -
                    new Date(b.inicio)
            )

            res.json({
                desde:
                    desde.toISOString(),
                hasta:
                    hasta.toISOString(),
                eventos
            })

        } catch (error) {

            res.status(500).json({
                error:
                    "No se pudieron obtener todos los eventos.",
                detalle:
                    error.message
            })
        }
    }
)

// =====================================================
// GRUPOS
// =====================================================

app.post(
    "/grupos",
    (req, res) => {

        if (!req.session.cuentaId) {

            return res.status(401).json({
                error:
                    "Primero inicia sesión."
            })
        }

        const nombre =
            String(
                req.body.nombreGrupo || ""
            ).trim()

        if (!nombre) {

            return res.status(400).json({
                error:
                    "Escribe un nombre para el grupo."
            })
        }

        const cuenta =
            db.prepare(`
                SELECT *
                FROM cuentas
                WHERE id = ?
            `).get(
                req.session.cuentaId
            )

        let codigo =
            generarCodigo()

        while (
            db.prepare(`
                SELECT id
                FROM grupos
                WHERE codigo_invitacion = ?
            `).get(codigo)
        ) {

            codigo =
                generarCodigo()
        }

        const resultado =
            db.prepare(`
                INSERT INTO grupos (
                    nombre,
                    creador,
                    codigo_invitacion
                )
                VALUES (?, ?, ?)
            `).run(
                nombre,
                cuenta.nombre,
                codigo
            )

        db.prepare(`
            INSERT INTO miembros_grupo (
                cuenta_id,
                grupo_id
            )
            VALUES (?, ?)
        `).run(
            cuenta.id,
            resultado.lastInsertRowid
        )

        res.json({
            id:
                resultado.lastInsertRowid,
            nombre,
            creador:
                cuenta.nombre,
            codigoInvitacion:
                codigo
        })
    }
)

function unirseAGrupo(req, res) {

    if (!req.session.cuentaId) {

        return res.status(401).json({
            error:
                "Primero inicia sesión."
        })
    }

    /*
     * Aceptamos varios nombres de campo por compatibilidad
     * con versiones anteriores del frontend y normalizamos
     * códigos pegados con espacios, guiones, etc.
     */
    const codigoOriginal =
        req.body.codigoInvitacion ??
        req.body.codigo ??
        req.body.invitationCode ??
        ""

    const codigo =
        String(codigoOriginal)
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "")

    if (codigo.length !== 6) {

        return res.status(400).json({
            error:
                "El código debe tener 6 caracteres."
        })
    }

    const grupo =
        db.prepare(`
            SELECT *
            FROM grupos
            WHERE UPPER(codigo_invitacion) = ?
        `).get(codigo)

    if (!grupo) {

        return res.status(404).json({
            error:
                "No existe ningún grupo con ese código."
        })
    }

    try {

        db.prepare(`
            INSERT INTO miembros_grupo (
                cuenta_id,
                grupo_id
            )
            VALUES (?, ?)
        `).run(
            req.session.cuentaId,
            grupo.id
        )

    } catch (error) {

        if (
            error.message.includes(
                "UNIQUE constraint failed"
            )
        ) {

            return res.json({
                mensaje:
                    "Ya perteneces a este grupo",
                yaEsMiembro: true,
                id: grupo.id,
                nombre: grupo.nombre,
                creador: grupo.creador,
                codigoInvitacion:
                    grupo.codigo_invitacion,
                grupo
            })
        }

        throw error
    }

    res.json({
        mensaje:
            "Te has unido al grupo.",
        yaEsMiembro: false,
        id: grupo.id,
        nombre: grupo.nombre,
        creador: grupo.creador,
        codigoInvitacion:
            grupo.codigo_invitacion,
        grupo
    })
}

app.post(
    "/unirse",
    unirseAGrupo
)

app.post(
    "/grupos/unirse",
    unirseAGrupo
)

app.get(
    "/grupos",
    (req, res) => {

        if (!req.session.cuentaId) {

            return res.status(401).json({
                error:
                    "Primero inicia sesión."
            })
        }

        const grupos =
            db.prepare(`
                SELECT
                    grupos.id,
                    grupos.nombre,
                    grupos.creador,
                    grupos.codigo_invitacion,
                    (
                        SELECT COUNT(*)
                        FROM miembros_grupo AS mg_count
                        WHERE mg_count.grupo_id = grupos.id
                    ) AS miembros_count
                FROM grupos
                INNER JOIN miembros_grupo
                    ON grupos.id =
                       miembros_grupo.grupo_id
                WHERE miembros_grupo.cuenta_id = ?
                ORDER BY grupos.id DESC
            `).all(
                req.session.cuentaId
            )

        res.json(grupos)
    }
)

app.delete(
    "/grupos/:id",
    async (req, res) => {
        try {
            if (!req.session.cuentaId) {
                return res.status(401).json({ error: "Primero inicia sesión." })
            }

            const grupoId = Number(req.params.id)
            const cuentaId = Number(req.session.cuentaId)

            if (!Number.isInteger(grupoId) || grupoId <= 0) {
                return res.status(400).json({ error: "Grupo no válido." })
            }

            const miembro = db.prepare(`
                SELECT id
                FROM miembros_grupo
                WHERE grupo_id = ? AND cuenta_id = ?
            `).get(grupoId, cuentaId)

            if (!miembro) {
                return res.status(404).json({ error: "No perteneces a este grupo." })
            }

            const pendientes = db.prepare(`
                SELECT id
                FROM eventos_grupo
                WHERE grupo_id = ? AND estado = 'pendiente'
            `).all(grupoId).map(fila => fila.id)

            const operacion = db.transaction(() => {
                db.prepare(`
                    DELETE FROM confirmaciones_evento
                    WHERE cuenta_id = ?
                      AND evento_grupo_id IN (
                          SELECT id FROM eventos_grupo WHERE grupo_id = ?
                      )
                `).run(cuentaId, grupoId)

                db.prepare(`
                    DELETE FROM escrituras_evento
                    WHERE grupo_id = ? AND cuenta_id = ?
                `).run(grupoId, cuentaId)

                db.prepare(`
                    DELETE FROM miembros_grupo
                    WHERE grupo_id = ? AND cuenta_id = ?
                `).run(grupoId, cuentaId)

                const restantes = db.prepare(`
                    SELECT COUNT(*) AS total
                    FROM miembros_grupo
                    WHERE grupo_id = ?
                `).get(grupoId).total

                if (restantes === 0) {
                    db.prepare(`
                        DELETE FROM confirmaciones_evento
                        WHERE evento_grupo_id IN (
                            SELECT id FROM eventos_grupo WHERE grupo_id = ?
                        )
                    `).run(grupoId)

                    db.prepare(`DELETE FROM escrituras_evento WHERE grupo_id = ?`).run(grupoId)
                    db.prepare(`DELETE FROM eventos_grupo WHERE grupo_id = ?`).run(grupoId)
                    db.prepare(`DELETE FROM grupos WHERE id = ?`).run(grupoId)
                }

                return restantes
            })

            const restantes = operacion()

            if (restantes > 0) {
                for (const eventoId of pendientes) {
                    try {
                        await finalizarEventoSiHayConsenso(eventoId)
                    } catch (error) {
                        console.error("No se pudo reevaluar el consenso tras abandonar grupo:", error.message)
                    }
                }
            }

            res.json({ ok: true, grupoId, restantes })
        } catch (error) {
            res.status(500).json({
                error: "No se pudo eliminar el grupo de Tus planes.",
                detalle: error.message
            })
        }
    }
)

app.get(
    "/grupos/:id",
    (req, res) => {

        if (!req.session.cuentaId) {

            return res.status(401).json({
                error:
                    "Primero inicia sesión."
            })
        }

        const grupo =
            db.prepare(`
                SELECT *
                FROM grupos
                WHERE id = ?
            `).get(
                req.params.id
            )

        if (!grupo) {

            return res.status(404).json({
                error:
                    "Grupo no encontrado."
            })
        }

        const miembros =
            db.prepare(`
                SELECT
                    cuentas.id,
                    cuentas.nombre,
                    cuentas.email,

                    CASE
                        WHEN
                            cuentas.google_refresh_token
                            IS NOT NULL

                        OR EXISTS (
                            SELECT 1
                            FROM calendarios
                            WHERE
                                calendarios.cuenta_id =
                                cuentas.id
                            AND
                                calendarios.grant_id IS NOT NULL
                            AND
                                calendarios.conectado = 1
                        )

                        THEN 1
                        ELSE 0
                    END AS calendar_conectado

                FROM cuentas
                INNER JOIN miembros_grupo
                    ON cuentas.id =
                       miembros_grupo.cuenta_id
                WHERE miembros_grupo.grupo_id = ?
            `).all(
                req.params.id
            )

        res.json({
            id:
                grupo.id,
            nombre:
                grupo.nombre,
            creador:
                grupo.creador,
            codigoInvitacion:
                grupo.codigo_invitacion,
            miembros,
            eventos:
                obtenerEventoVisibleGrupo(
                    Number(grupo.id),
                    req.session.cuentaId
                )
        })
    }
)

// =====================================================
// DISPONIBILIDAD
// =====================================================

function inicioDelDia(fecha) {

    const resultado =
        new Date(fecha)

    resultado.setHours(
        0,
        0,
        0,
        0
    )

    return resultado
}

function siguienteDia(fecha) {

    const resultado =
        inicioDelDia(fecha)

    resultado.setDate(
        resultado.getDate() + 1
    )

    return resultado
}

function minutosEntre(inicio, fin) {

    return Math.round(
        (
            new Date(fin).getTime() -
            new Date(inicio).getTime()
        ) / 60000
    )
}

function unirIntervalos(intervalos) {

    if (!intervalos.length) return []

    const ordenados =
        intervalos
            .filter(
                item =>
                    item &&
                    item.inicio &&
                    item.fin &&
                    new Date(item.fin) >
                    new Date(item.inicio)
            )
            .map(item => ({
                inicio:
                    new Date(item.inicio),
                fin:
                    new Date(item.fin)
            }))
            .sort(
                (a, b) =>
                    a.inicio - b.inicio
            )

    const resultado = []

    for (const actual of ordenados) {

        const ultimo =
            resultado[
                resultado.length - 1
            ]

        if (!ultimo) {

            resultado.push({
                inicio:
                    new Date(actual.inicio),
                fin:
                    new Date(actual.fin)
            })

            continue
        }

        if (
            actual.inicio <=
            ultimo.fin
        ) {

            if (
                actual.fin >
                ultimo.fin
            ) {

                ultimo.fin =
                    new Date(actual.fin)
            }

        } else {

            resultado.push({
                inicio:
                    new Date(actual.inicio),
                fin:
                    new Date(actual.fin)
            })
        }
    }

    return resultado
}

function calcularHuecosLibres(
    eventos,
    desde,
    hasta
) {

    const inicio =
        new Date(desde)

    const final =
        new Date(hasta)

    const ocupados =
        unirIntervalos(
            eventos
                .filter(
                    evento =>
                        evento &&
                        evento.inicio &&
                        evento.fin
                )
                .map(evento => {

                    const eventoInicio =
                        new Date(
                            evento.inicio
                        )

                    const eventoFin =
                        new Date(
                            evento.fin
                        )

                    return {

                        inicio:
                            new Date(
                                Math.max(
                                    eventoInicio.getTime(),
                                    inicio.getTime()
                                )
                            ),

                        fin:
                            new Date(
                                Math.min(
                                    eventoFin.getTime(),
                                    final.getTime()
                                )
                            )
                    }
                })
                .filter(
                    evento =>
                        evento.fin >
                        evento.inicio
                )
        )

    const huecos = []

    let actual =
        new Date(inicio)

    for (const ocupado of ocupados) {

        if (
            ocupado.inicio >
            actual
        ) {

            huecos.push({
                inicio:
                    new Date(actual),
                fin:
                    new Date(ocupado.inicio)
            })
        }

        if (
            ocupado.fin >
            actual
        ) {

            actual =
                new Date(ocupado.fin)
        }
    }

    if (actual < final) {

        huecos.push({
            inicio:
                new Date(actual),
            fin:
                new Date(final)
        })
    }

    return huecos
}

function cruzarHuecos(
    huecosPersonas
) {

    if (
        !huecosPersonas.length
    ) {
        return []
    }

    let resultado =
        huecosPersonas[0].map(
            item => ({
                inicio:
                    new Date(item.inicio),
                fin:
                    new Date(item.fin)
            })
        )

    for (
        let i = 1;
        i < huecosPersonas.length;
        i++
    ) {

        const siguientes =
            huecosPersonas[i]

        const nuevos = []

        for (const a of resultado) {

            for (const b of siguientes) {

                const inicio =
                    new Date(
                        Math.max(
                            a.inicio.getTime(),
                            b.inicio.getTime()
                        )
                    )

                const fin =
                    new Date(
                        Math.min(
                            a.fin.getTime(),
                            b.fin.getTime()
                        )
                    )

                if (inicio < fin) {

                    nuevos.push({
                        inicio,
                        fin
                    })
                }
            }
        }

        resultado =
            unirIntervalos(nuevos)
    }

    return resultado
}

function filtrarPorDuracion(
    huecos,
    duracion
) {

    const minutos =
        Number(duracion)

    if (
        !Number.isFinite(minutos) ||
        minutos <= 0
    ) {
        return huecos
    }

    return huecos.filter(
        hueco =>
            minutosEntre(
                hueco.inicio,
                hueco.fin
            ) >= minutos
    )
}

function recortarHuecos(
    huecos,
    desde,
    hasta
) {

    const inicio =
        new Date(desde)

    const final =
        new Date(hasta)

    return huecos
        .map(hueco => {

            const a =
                new Date(
                    Math.max(
                        new Date(
                            hueco.inicio
                        ).getTime(),
                        inicio.getTime()
                    )
                )

            const b =
                new Date(
                    Math.min(
                        new Date(
                            hueco.fin
                        ).getTime(),
                        final.getTime()
                    )
                )

            return {
                inicio: a,
                fin: b
            }
        })
        .filter(
            hueco =>
                hueco.inicio <
                hueco.fin
        )
}

function leerFechaParametro(
    valor
) {

    if (!valor) return null

    const fecha =
        new Date(valor)

    if (
        isNaN(
            fecha.getTime()
        )
    ) {
        return null
    }

    return fecha
}

// =====================================================
// CRITERIOS
// =====================================================

function obtenerCriteriosBusqueda(req) {

    const modos = [
        "mes",
        "semana",
        "dia",
        "horas"
    ]

    const modoSolicitado =
        String(
            req.query.modo || "semana"
        ).toLowerCase()

    const modo =
        modos.includes(
            modoSolicitado
        )
            ? modoSolicitado
            : "semana"

    let duracion =
        Number(
            req.query.duracionMinutos
        )

    if (
        !Number.isFinite(duracion) ||
        duracion <= 0
    ) {
        duracion = 60
    }

    duracion =
        Math.round(duracion)

    let incluirMadrugada =
        req.query.incluirMadrugada ===
        "true"

    if (modo !== "horas") {

        incluirMadrugada =
            true
    }

    return {
        modo,
        duracionMinutos:
            duracion,
        incluirMadrugada
    }
}

// =====================================================
// VENTANA DE BÚSQUEDA
// =====================================================

function obtenerVentanaBusqueda(
    criterios,
    req
) {

    const fechaDesdeParametro =
        leerFechaParametro(
            req.query.desde
        )

    const fechaHastaParametro =
        leerFechaParametro(
            req.query.hasta
        )

    /*
     * Si el frontend proporciona explícitamente
     * Desde/Hasta, esos valores mandan.
     */

    if (
        fechaDesdeParametro &&
        fechaHastaParametro &&
        fechaDesdeParametro <
        fechaHastaParametro
    ) {

        return {

            desde:
                fechaDesdeParametro,

            hasta:
                fechaHastaParametro
        }
    }

    const fechaParametro =
        leerFechaParametro(
            req.query.fecha
        )

    const base =
        fechaParametro ||
        new Date()

    if (criterios.modo === "mes") {

        const desde =
            inicioDelDia(base)

        const hasta =
            new Date(desde)

        hasta.setMonth(
            hasta.getMonth() + 1
        )

        return {
            desde,
            hasta
        }
    }

    if (criterios.modo === "semana") {

        const desde =
            inicioDelDia(base)

        const hasta =
            new Date(desde)

        hasta.setDate(
            hasta.getDate() + 7
        )

        return {
            desde,
            hasta
        }
    }

    if (criterios.modo === "dia") {

        const desde =
            inicioDelDia(base)

        const hasta =
            siguienteDia(desde)

        return {
            desde,
            hasta
        }
    }

    /*
     * HORAS:
     *
     * Con madrugada:
     * 00:00 → 24:00
     *
     * Sin madrugada:
     * 08:00 → 24:00
     *
     * Importante:
     * Esto NO elimina el hueco real.
     * Solo limita la ventana consultada.
     */

    const dia =
        inicioDelDia(base)

    if (
        criterios.incluirMadrugada
    ) {

        return {
            desde:
                dia,
            hasta:
                siguienteDia(dia)
        }
    }

    const desde =
        new Date(dia)

    desde.setHours(
        8,
        0,
        0,
        0
    )

    return {
        desde,
        hasta:
            siguienteDia(dia)
    }
}

function usuarioPerteneceAlGrupo(
    cuentaId,
    grupoId
) {

    return Boolean(
        db.prepare(`
            SELECT id
            FROM miembros_grupo
            WHERE cuenta_id = ?
            AND grupo_id = ?
        `).get(
            cuentaId,
            grupoId
        )
    )
}

// =====================================================
// DISPONIBILIDAD
// =====================================================

app.get(
    "/grupos/:id/disponibilidad",
    async (req, res) => {

        try {

            if (!req.session.cuentaId) {

                return res.status(401).json({
                    error:
                        "Primero inicia sesión."
                })
            }

            const grupoId =
                Number(
                    req.params.id
                )

            if (
                !usuarioPerteneceAlGrupo(
                    req.session.cuentaId,
                    grupoId
                )
            ) {

                return res.status(403).json({
                    error:
                        "No perteneces a este grupo."
                })
            }

            const grupo =
                db.prepare(`
                    SELECT *
                    FROM grupos
                    WHERE id = ?
                `).get(grupoId)

            if (!grupo) {

                return res.status(404).json({
                    error:
                        "Grupo no encontrado."
                })
            }

            const criterios =
                obtenerCriteriosBusqueda(req)

            const ventana =
                obtenerVentanaBusqueda(
                    criterios,
                    req
                )

            const desde =
                ventana.desde

            const hasta =
                ventana.hasta

            const miembros =
                db.prepare(`
                    SELECT
                        cuentas.id,
                        cuentas.nombre,
                        cuentas.email,
                        cuentas.google_refresh_token,
                        cuentas.calendario_principal
                    FROM cuentas
                    INNER JOIN miembros_grupo
                        ON cuentas.id =
                           miembros_grupo.cuenta_id
                    WHERE miembros_grupo.grupo_id = ?
                    ORDER BY miembros_grupo.id ASC
                `).all(grupoId)

            if (!miembros.length) {

                return res.status(400).json({
                    error:
                        "El grupo no tiene miembros."
                })
            }

            const huecosPersonas = []

            const miembrosDisponibilidad = []

            for (const miembro of miembros) {

                const eventos = []

                // -----------------------------
                // GOOGLE
                // -----------------------------

                if (
                    miembro.calendario_principal === "google" &&
                    miembro.google_refresh_token
                ) {

                    try {

                        const eventosGoogle =
                            await obtenerEventosGoogle(
                                miembro.google_refresh_token,
                                desde,
                                hasta
                            )

                        eventos.push(
                            ...eventosGoogle.map(
                                evento => ({
                                    inicio:
                                        evento.start?.dateTime ||
                                        evento.start?.date ||
                                        null,

                                    fin:
                                        evento.end?.dateTime ||
                                        evento.end?.date ||
                                        null
                                })
                            )
                        )

                    } catch (error) {

                        console.error(
                            `Google ${miembro.nombre}:`,
                            error.message
                        )
                    }
                }

                // -----------------------------
                // ICLOUD
                // -----------------------------

                const conexiones =
                    db.prepare(`
                        SELECT *
                        FROM calendarios
                        WHERE cuenta_id = ?
                        AND grant_id IS NOT NULL
                        AND conectado = 1
                        AND proveedor = 'icloud'
                    `).all(
                        miembro.calendario_principal === "icloud" ? miembro.id : -1
                    )

                for (const conexion of conexiones) {

                    try {

                        const eventosNylas =
                            await obtenerEventosNylas(
                                conexion.grant_id,
                                desde,
                                hasta,
                                conexion.proveedor
                            )

                        eventos.push(
                            ...eventosNylas.map(
                                evento => ({
                                    inicio:
                                        evento.inicio,
                                    fin:
                                        evento.fin
                                })
                            )
                        )

                    } catch (error) {

                        console.error(
                            `Nylas ${miembro.nombre}:`,
                            error.message
                        )
                    }
                }

                const tieneCalendario =
                    (miembro.calendario_principal === "google" && Boolean(miembro.google_refresh_token)) ||
                    (miembro.calendario_principal === "icloud" && conexiones.length > 0)

                if (!tieneCalendario) {

                    return res.status(400).json({
                        error:
                            `${miembro.nombre} no tiene ningún calendario conectado.`
                    })
                }

                let huecos =
                    calcularHuecosLibres(
                        eventos,
                        desde,
                        hasta
                    )

                /*
                 * Para HORAS sin madrugada:
                 *
                 * Ya empezamos la ventana a las 08:00.
                 *
                 * Aun así hacemos el recorte explícito
                 * para que quede garantizado.
                 */

                if (
                    criterios.modo === "horas" &&
                    !criterios.incluirMadrugada
                ) {

                    const limite =
                        new Date(desde)

                    limite.setHours(
                        8,
                        0,
                        0,
                        0
                    )

                    huecos =
                        recortarHuecos(
                            huecos,
                            limite,
                            hasta
                        )
                }

                huecosPersonas.push(huecos)

                miembrosDisponibilidad.push({

                    id:
                        miembro.id,

                    nombre:
                        miembro.nombre,

                    foto:
                        null,

                    huecos:
                        huecos.map(
                            hueco => ({
                                inicio:
                                    hueco.inicio.toISOString(),

                                fin:
                                    hueco.fin.toISOString(),

                                minutos:
                                    minutosEntre(
                                        hueco.inicio,
                                        hueco.fin
                                    )
                            })
                        )
                })
            }

            /*
             * Primero cruzamos calendarios.
             * Después aplicamos duración.
             */

            let disponibilidad =
                cruzarHuecos(
                    huecosPersonas
                )

            disponibilidad =
                filtrarPorDuracion(
                    disponibilidad,
                    criterios.duracionMinutos
                )

            const disponibilidadFormateada =
                disponibilidad.map(
                    hueco => ({
                        inicio:
                            hueco.inicio.toISOString(),

                        fin:
                            hueco.fin.toISOString(),

                        minutos:
                            minutosEntre(
                                hueco.inicio,
                                hueco.fin
                            )
                    })
                )

            res.json({

                grupo: {
                    id:
                        grupo.id,
                    nombre:
                        grupo.nombre
                },

                criterios,

                desde:
                    desde.toISOString(),

                hasta:
                    hasta.toISOString(),

                disponibilidad:
                    disponibilidadFormateada,

                disponibilidadPorMiembro:
                    miembrosDisponibilidad
            })

        } catch (error) {

            console.error(
                "Error disponibilidad:",
                error
            )

            res.status(500).json({

                error:
                    "No se pudo calcular la disponibilidad.",

                detalle:
                    error.message
            })
        }
    }
)

// =====================================================
// CREAR EVENTO
// =====================================================

async function crearEventoParaMiembro(
    miembro,
    inicio,
    fin,
    titulo,
    descripcion
) {

    const cuentaDestino = db.prepare(`
        SELECT calendario_principal, google_refresh_token
        FROM cuentas
        WHERE id = ?
    `).get(miembro.id) || miembro

    if (
        cuentaDestino.calendario_principal === "google" &&
        cuentaDestino.google_refresh_token
    ) {

        return {
            proveedor:
                "google",

            calendar_id:
                "primary",

            ...await crearEventoGoogle(
                cuentaDestino.google_refresh_token,
                inicio,
                fin,
                titulo,
                descripcion
            )
        }
    }

    const conexion =
        db.prepare(`
            SELECT
                proveedor,
                grant_id
            FROM calendarios
            WHERE cuenta_id = ?
            AND conectado = 1
            AND grant_id IS NOT NULL
            AND proveedor = ?
            ORDER BY id ASC
            LIMIT 1
        `).get(miembro.id, cuentaDestino.calendario_principal)

    if (
        conexion &&
        conexion.grant_id
    ) {

        return {
            proveedor:
                conexion.proveedor,

            ...await crearEventoIcloud(
                conexion.grant_id,
                inicio,
                fin,
                titulo,
                descripcion
            )
        }
    }

    throw new Error(
        "Este miembro no tiene ningún calendario conectado."
    )
}

// =====================================================
// PROPUESTAS DE EVENTO + CONSENSO DEL GRUPO
// =====================================================

function obtenerMiembrosGrupo(grupoId) {
    return db.prepare(`
        SELECT
            cuentas.id,
            cuentas.nombre,
            cuentas.email,
            cuentas.calendario_principal,
            cuentas.google_refresh_token
        FROM cuentas
        INNER JOIN miembros_grupo
            ON cuentas.id = miembros_grupo.cuenta_id
        WHERE miembros_grupo.grupo_id = ?
        ORDER BY cuentas.id ASC
    `).all(grupoId)
}

function obtenerEstadoEvento(eventoId, cuentaId = null) {
    const evento = db.prepare(`
        SELECT *
        FROM eventos_grupo
        WHERE id = ?
    `).get(eventoId)

    if (!evento) return null

    const miembros = obtenerMiembrosGrupo(evento.grupo_id)
    const confirmaciones = db.prepare(`
        SELECT
            confirmaciones_evento.cuenta_id,
            confirmaciones_evento.confirmed_at,
            cuentas.nombre
        FROM confirmaciones_evento
        INNER JOIN cuentas
            ON cuentas.id = confirmaciones_evento.cuenta_id
        WHERE confirmaciones_evento.evento_grupo_id = ?
          AND confirmaciones_evento.confirmado = 1
    `).all(evento.id)

    const confirmados = new Set(confirmaciones.map(item => Number(item.cuenta_id)))

    return {
        ...evento,
        total_miembros: miembros.length,
        total_confirmados: confirmaciones.length,
        confirmado_por_mi: cuentaId == null ? false : confirmados.has(Number(cuentaId)),
        confirmaciones,
        pendientes: miembros
            .filter(miembro => !confirmados.has(Number(miembro.id)))
            .map(miembro => ({ id: miembro.id, nombre: miembro.nombre }))
    }
}

function obtenerEventoVisibleGrupo(grupoId, cuentaId = null) {
    const pendiente = db.prepare(`
        SELECT id
        FROM eventos_grupo
        WHERE grupo_id = ?
          AND estado IN ('pendiente', 'finalizando')
        ORDER BY id DESC
        LIMIT 1
    `).get(grupoId)

    const confirmado = db.prepare(`
        SELECT id
        FROM eventos_grupo
        WHERE grupo_id = ?
          AND estado = 'confirmado'
        ORDER BY id DESC
        LIMIT 1
    `).get(grupoId)

    return {
        pendiente: pendiente ? obtenerEstadoEvento(pendiente.id, cuentaId) : null,
        confirmado: confirmado ? obtenerEstadoEvento(confirmado.id, cuentaId) : null
    }
}

async function actualizarEventoGoogle(
    refreshToken,
    eventoId,
    inicio,
    fin,
    titulo,
    descripcion
) {
    const calendarClient = crearGoogleCalendarClient(refreshToken)
    const calendar = google.calendar({ version: "v3", auth: calendarClient })

    const respuesta = await calendar.events.patch({
        calendarId: "primary",
        eventId: eventoId,
        requestBody: {
            summary: titulo,
            description: descripcion,
            start: { dateTime: inicio, timeZone: "Europe/Madrid" },
            end: { dateTime: fin, timeZone: "Europe/Madrid" }
        }
    })

    return {
        id: respuesta.data.id,
        enlace: respuesta.data.htmlLink || null,
        calendar_id: "primary"
    }
}

async function actualizarEventoIcloud(
    grantId,
    eventoId,
    calendarId,
    inicio,
    fin,
    titulo,
    descripcion
) {
    if (!calendarId) {
        throw new Error("No se conoce el calendario de iCloud del evento anterior.")
    }

    const respuesta = await fetch(
        `${NYLAS_API_BASE}/v3/grants/${encodeURIComponent(grantId)}/events/${encodeURIComponent(eventoId)}?calendar_id=${encodeURIComponent(calendarId)}`,
        {
            method: "PUT",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${NYLAS_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                title: titulo,
                description: descripcion,
                busy: true,
                when: {
                    start_time: Math.floor(new Date(inicio).getTime() / 1000),
                    end_time: Math.floor(new Date(fin).getTime() / 1000)
                }
            })
        }
    )

    const datos = await respuesta.json()

    if (!respuesta.ok) {
        throw new Error(
            datos?.error?.message || datos?.message || "No se pudo actualizar el evento en iCloud."
        )
    }

    return {
        id: datos?.data?.id || datos?.id || eventoId,
        enlace: datos?.data?.html_link || datos?.data?.web_url || null,
        calendar_id: calendarId
    }
}

async function sincronizarEventoConfirmado(evento) {
    const grupo = db.prepare(`SELECT * FROM grupos WHERE id = ?`).get(evento.grupo_id)
    const miembros = obtenerMiembrosGrupo(evento.grupo_id)
    const descripcion = `Evento acordado por todo el grupo en Agend.us · ${grupo?.nombre || "Grupo"}.`
    const resultados = []

    for (const miembro of miembros) {
        try {
            const escrituraAnterior = db.prepare(`
                SELECT *
                FROM escrituras_evento
                WHERE grupo_id = ? AND cuenta_id = ?
            `).get(evento.grupo_id, miembro.id)

            let resultado
            let proveedor

            if (
                escrituraAnterior?.evento_externo_id &&
                escrituraAnterior.proveedor === "google" &&
                miembro.calendario_principal === "google" &&
                miembro.google_refresh_token
            ) {
                proveedor = "google"
                resultado = await actualizarEventoGoogle(
                    miembro.google_refresh_token,
                    escrituraAnterior.evento_externo_id,
                    evento.inicio,
                    evento.fin,
                    evento.titulo,
                    descripcion
                )
            } else if (
                escrituraAnterior?.evento_externo_id &&
                escrituraAnterior.proveedor === "icloud" &&
                miembro.calendario_principal === "icloud"
            ) {
                const conexion = db.prepare(`
                    SELECT grant_id
                    FROM calendarios
                    WHERE cuenta_id = ?
                      AND proveedor = 'icloud'
                      AND conectado = 1
                      AND grant_id IS NOT NULL
                    ORDER BY id ASC
                    LIMIT 1
                `).get(miembro.id)

                if (!conexion?.grant_id) {
                    throw new Error("iCloud no está conectado.")
                }

                proveedor = "icloud"
                resultado = await actualizarEventoIcloud(
                    conexion.grant_id,
                    escrituraAnterior.evento_externo_id,
                    escrituraAnterior.calendar_id,
                    evento.inicio,
                    evento.fin,
                    evento.titulo,
                    descripcion
                )
            } else {
                const creado = await crearEventoParaMiembro(
                    miembro,
                    evento.inicio,
                    evento.fin,
                    evento.titulo,
                    descripcion
                )
                proveedor = creado.proveedor
                resultado = creado
            }

            db.prepare(`
                INSERT INTO escrituras_evento (
                    grupo_id, cuenta_id, proveedor, evento_externo_id,
                    calendar_id, enlace, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(grupo_id, cuenta_id) DO UPDATE SET
                    proveedor = excluded.proveedor,
                    evento_externo_id = excluded.evento_externo_id,
                    calendar_id = excluded.calendar_id,
                    enlace = excluded.enlace,
                    updated_at = CURRENT_TIMESTAMP
            `).run(
                evento.grupo_id,
                miembro.id,
                proveedor,
                resultado.id || null,
                resultado.calendar_id || escrituraAnterior?.calendar_id || null,
                resultado.enlace || null
            )

            resultados.push({ cuenta_id: miembro.id, nombre: miembro.nombre, proveedor, ok: true })
        } catch (error) {
            resultados.push({
                cuenta_id: miembro.id,
                nombre: miembro.nombre,
                proveedor: miembro.calendario_principal || null,
                ok: false,
                error: error.message
            })
        }
    }

    return resultados
}

async function finalizarEventoSiHayConsenso(eventoId) {
    const evento = db.prepare(`SELECT * FROM eventos_grupo WHERE id = ?`).get(eventoId)
    if (!evento || evento.estado !== "pendiente") {
        return evento ? obtenerEstadoEvento(evento.id) : null
    }

    const totalMiembros = db.prepare(`
        SELECT COUNT(*) AS total
        FROM miembros_grupo
        WHERE grupo_id = ?
    `).get(evento.grupo_id).total

    const totalConfirmados = db.prepare(`
        SELECT COUNT(*) AS total
        FROM confirmaciones_evento
        WHERE evento_grupo_id = ? AND confirmado = 1
    `).get(evento.id).total

    if (totalMiembros === 0 || totalConfirmados < totalMiembros) {
        return obtenerEstadoEvento(evento.id)
    }

    const bloqueo = db.prepare(`
        UPDATE eventos_grupo
        SET estado = 'finalizando'
        WHERE id = ? AND estado = 'pendiente'
    `).run(evento.id)

    if (bloqueo.changes !== 1) {
        return obtenerEstadoEvento(evento.id)
    }

    const eventoBloqueado = db.prepare(`SELECT * FROM eventos_grupo WHERE id = ?`).get(evento.id)
    const resultados = await sincronizarEventoConfirmado(eventoBloqueado)

    db.transaction(() => {
        if (eventoBloqueado.reemplaza_evento_id) {
            db.prepare(`
                UPDATE eventos_grupo
                SET estado = 'reemplazado'
                WHERE id = ? AND estado = 'confirmado'
            `).run(eventoBloqueado.reemplaza_evento_id)
        }

        db.prepare(`
            UPDATE eventos_grupo
            SET estado = 'confirmado', confirmed_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(eventoBloqueado.id)
    })()

    return {
        ...obtenerEstadoEvento(eventoBloqueado.id),
        resultados
    }
}

app.post(
    "/grupos/:id/evento",
    async (req, res) => {
        try {
            if (!req.session.cuentaId) {
                return res.status(401).json({ error: "Primero inicia sesión." })
            }

            const grupoId = Number(req.params.id)
            if (!usuarioPerteneceAlGrupo(req.session.cuentaId, grupoId)) {
                return res.status(403).json({ error: "No perteneces a este grupo." })
            }

            const grupo = db.prepare(`SELECT * FROM grupos WHERE id = ?`).get(grupoId)
            if (!grupo) return res.status(404).json({ error: "Grupo no encontrado." })

            const fechaInicio = new Date(String(req.body.inicio || ""))
            const fechaFin = new Date(String(req.body.fin || ""))
            if (isNaN(fechaInicio.getTime()) || isNaN(fechaFin.getTime()) || fechaInicio >= fechaFin) {
                return res.status(400).json({ error: "La fecha del evento no es válida." })
            }

            const pendiente = db.prepare(`
                SELECT id FROM eventos_grupo
                WHERE grupo_id = ? AND estado IN ('pendiente', 'finalizando')
                ORDER BY id DESC LIMIT 1
            `).get(grupoId)

            if (pendiente) {
                return res.status(409).json({
                    error: "Ya hay una propuesta pendiente de confirmación en este grupo."
                })
            }

            const actual = db.prepare(`
                SELECT * FROM eventos_grupo
                WHERE grupo_id = ? AND estado = 'confirmado'
                ORDER BY id DESC LIMIT 1
            `).get(grupoId)

            const esEdicion = Boolean(actual)
            const revision = actual ? Number(actual.revision || 1) + 1 : 1
            const titulo = String(req.body.titulo || `Encuentro · ${grupo.nombre}`).trim()

            const resultado = db.prepare(`
                INSERT INTO eventos_grupo (
                    grupo_id, revision, titulo, inicio, fin, estado,
                    creador_cuenta_id, reemplaza_evento_id
                ) VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?)
            `).run(
                grupoId,
                revision,
                titulo,
                fechaInicio.toISOString(),
                fechaFin.toISOString(),
                req.session.cuentaId,
                esEdicion ? actual.id : null
            )

            const eventoId = Number(resultado.lastInsertRowid)

            // Proponer el evento cuenta como la confirmación del proponente.
            db.prepare(`
                INSERT OR REPLACE INTO confirmaciones_evento (
                    evento_grupo_id, cuenta_id, confirmado, confirmed_at
                ) VALUES (?, ?, 1, CURRENT_TIMESTAMP)
            `).run(eventoId, req.session.cuentaId)

            const final = await finalizarEventoSiHayConsenso(eventoId)

            res.json({
                ok: true,
                mensaje: final?.estado === "confirmado"
                    ? "Evento confirmado y añadido a los calendarios."
                    : "Propuesta enviada. Falta la confirmación del resto del grupo.",
                evento: obtenerEstadoEvento(eventoId, req.session.cuentaId)
            })
        } catch (error) {
            console.error("Error proponiendo evento:", error)
            res.status(500).json({ ok: false, error: "No se pudo proponer el evento.", detalle: error.message })
        }
    }
)

app.post(
    "/eventos/:id/confirmar",
    async (req, res) => {
        try {
            if (!req.session.cuentaId) {
                return res.status(401).json({ error: "Primero inicia sesión." })
            }

            const evento = db.prepare(`SELECT * FROM eventos_grupo WHERE id = ?`).get(Number(req.params.id))
            if (!evento) return res.status(404).json({ error: "Propuesta no encontrada." })
            if (!usuarioPerteneceAlGrupo(req.session.cuentaId, evento.grupo_id)) {
                return res.status(403).json({ error: "No perteneces a este grupo." })
            }
            if (!['pendiente', 'finalizando'].includes(evento.estado)) {
                return res.json({ ok: true, evento: obtenerEstadoEvento(evento.id, req.session.cuentaId) })
            }

            db.prepare(`
                INSERT OR REPLACE INTO confirmaciones_evento (
                    evento_grupo_id, cuenta_id, confirmado, confirmed_at
                ) VALUES (?, ?, 1, CURRENT_TIMESTAMP)
            `).run(evento.id, req.session.cuentaId)

            const final = await finalizarEventoSiHayConsenso(evento.id)

            res.json({
                ok: true,
                evento: obtenerEstadoEvento(evento.id, req.session.cuentaId),
                finalizado: final?.estado === 'confirmado',
                resultados: final?.resultados || null
            })
        } catch (error) {
            console.error("Error confirmando evento:", error)
            res.status(500).json({ error: "No se pudo confirmar el evento.", detalle: error.message })
        }
    }
)

app.get(
    "/eventos/pendientes",
    (req, res) => {
        if (!req.session.cuentaId) {
            return res.status(401).json({ error: "Primero inicia sesión." })
        }

        const filas = db.prepare(`
            SELECT eventos_grupo.id
            FROM eventos_grupo
            INNER JOIN miembros_grupo
                ON miembros_grupo.grupo_id = eventos_grupo.grupo_id
            LEFT JOIN confirmaciones_evento
                ON confirmaciones_evento.evento_grupo_id = eventos_grupo.id
               AND confirmaciones_evento.cuenta_id = ?
               AND confirmaciones_evento.confirmado = 1
            WHERE miembros_grupo.cuenta_id = ?
              AND eventos_grupo.estado = 'pendiente'
              AND confirmaciones_evento.cuenta_id IS NULL
            ORDER BY eventos_grupo.id DESC
        `).all(req.session.cuentaId, req.session.cuentaId)

        res.json({
            eventos: filas.map(fila => obtenerEstadoEvento(fila.id, req.session.cuentaId))
        })
    }
)

// =====================================================
// LOGOUT
// =====================================================

app.post(
    "/logout",
    (req, res) => {

        req.session.destroy(error => {

            if (error) {

                return res.status(500).json({
                    error:
                        "No se pudo cerrar la sesión."
                })
            }

            res.json({
                mensaje:
                    "Sesión cerrada."
            })
        })
    }
)

// =====================================================
// SERVIDOR
// =====================================================

app.listen(
    puerto,
    "0.0.0.0",
    () => {

        console.log(
            "===================================="
        )

        console.log(
            "Agend.us"
        )

        console.log(
            "Servidor funcionando en:"
        )

        console.log(
            `http://localhost:${puerto}`
        )

        console.log(
            "Nylas:",
            NYLAS_API_BASE
        )

        console.log(
            "Zona horaria:",
            process.env.TZ
        )

        console.log(
            "===================================="
        )
    }
)