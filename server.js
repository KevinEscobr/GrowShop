// server.js
// Servidor Express para servir la app estática y exponer un API de productos.
// - Intenta leer productos desde PostgreSQL (tabla: products) usando DATABASE_URL
// - Si la tabla no existe o hay error, hace fallback a data/products.json

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const multer = require('multer');
// Normalización de typos comunes en variables de entorno (evita despliegues rotos por nombre mal escrito)
if(!process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_APT_KEY){
  process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_APT_KEY;
  console.warn('[CLOUDINARY] Advertencia: se detectó CLOUDINARY_APT_KEY (typo). Usándola como CLOUDINARY_API_KEY. Renombra la variable en el entorno.');
}
// ==== Cloudinary (opcional) ====
let cloudinary = null;
const hasCloudinaryDirect = !!process.env.CLOUDINARY_CLOUD_NAME && !!process.env.CLOUDINARY_API_KEY && !!process.env.CLOUDINARY_API_SECRET;
const hasCloudinaryUrl = !!process.env.CLOUDINARY_URL; // formato cloudinary://api_key:api_secret@cloud_name
const useCloudinary = hasCloudinaryDirect || hasCloudinaryUrl;
const cloudinaryOnly = process.env.FORCE_CLOUDINARY === '1';
if(useCloudinary){
  try {
    cloudinary = require('cloudinary').v2;
    if(hasCloudinaryDirect){
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
      });
    } else {
      // Si sólo se proporciona CLOUDINARY_URL, cloudinary.config() lee automáticamente de process.env
      cloudinary.config();
    }
    console.log('[CLOUDINARY] Configurado. Método:', hasCloudinaryDirect? 'vars separadas':'CLOUDINARY_URL', 'Folder:', process.env.CLOUDINARY_FOLDER || '(default)');
  } catch(e){
    console.warn('[CLOUDINARY] No se pudo cargar librería:', e.message);
  }
}
if(cloudinaryOnly && !useCloudinary){
  console.error('[CLOUDINARY] FORCE_CLOUDINARY=1 pero no hay configuración válida. Define CLOUDINARY_URL o CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET.');
  process.exit(1);
}
const uploadDir = path.join(__dirname, 'uploads');
if(!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
// Usamos memoryStorage si Cloudinary está activo para evitar escribir al FS efímero.
const storage = useCloudinary
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (_, __, cb)=> cb(null, uploadDir),
      filename: (_, file, cb)=>{
        const ext = path.extname(file.originalname)||'';
        cb(null, Date.now()+'-'+Math.random().toString(36).slice(2)+ext);
      }
    });
const upload = multer({ storage, limits:{ fileSize: 3 * 1024 * 1024 } }); // 3MB

// ===== Rate limit básico para subida de imágenes =====
const UPLOAD_WINDOW_MS = Number(process.env.UPLOAD_WINDOW_MS || 15*60*1000); // 15 minutos
const UPLOAD_MAX = Number(process.env.UPLOAD_MAX || 20); // máximo intentos dentro de la ventana
const uploadUsage = new Map(); // key -> { count, resetAt }
function uploadLimiter(req,res,next){
  const now = Date.now();
  const userKey = req.user ? 'u:'+req.user.uid : 'ip:'+(req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'ip');
  const entry = uploadUsage.get(userKey) || { count:0, resetAt: now + UPLOAD_WINDOW_MS };
  if(now > entry.resetAt){ entry.count = 0; entry.resetAt = now + UPLOAD_WINDOW_MS; }
  entry.count += 1; uploadUsage.set(userKey, entry);
  if(entry.count > UPLOAD_MAX){
    return res.status(429).json({ error:'Límite de subidas alcanzado', resetInMs: entry.resetAt - now });
  }
  res.set('X-Upload-Remaining', String(Math.max(0, UPLOAD_MAX - entry.count)));
  res.set('X-Upload-Reset', String(entry.resetAt));
  next();
}
setInterval(()=>{
  const now = Date.now();
  for(const [k,v] of uploadUsage.entries()) if(now > v.resetAt + UPLOAD_WINDOW_MS) uploadUsage.delete(k);
}, 60*60*1000);

// Helper para extraer public_id Cloudinary desde la URL completa (para futuras eliminaciones)
function extractCloudinaryPublicId(url){
  try {
    if(!url || !/res\.cloudinary\.com\//i.test(url)) return null;
    const idx = url.indexOf('/upload/');
    if(idx === -1) return null;
    let rest = url.slice(idx + 8).split('?')[0];
    rest = rest.replace(/^v\d+\//,'');
    const parts = rest.split('/');
    const last = parts.pop();
    if(!last) return null;
    const base = last.replace(/\.[a-z0-9]+$/i,'');
    parts.push(base);
    return parts.join('/');
  } catch(_){ return null; }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Pool opcional (sólo si hay DATABASE_URL)
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Render suele requerir SSL en PostgreSQL
    ssl: { rejectUnauthorized: false }
  });
  pool.on('error', (e)=> console.error('Error inesperado en pool PG:', e.message));
}

async function getDbStatus(){
  if(!pool) return { hasDatabaseUrl: !!process.env.DATABASE_URL, connected:false, error:'pool-null' };
  try {
    await pool.query('SELECT 1');
    return { hasDatabaseUrl:true, connected:true };
  } catch(e){
    return { hasDatabaseUrl:true, connected:false, error: e.code || e.message };
  }
}

// Log temprano del estado de la base de datos
(async ()=>{
  const st = await getDbStatus();
  if(st.connected){
    console.log('[DB.STATUS] Conectado a PostgreSQL (DATABASE_URL presente)');
  } else if(st.hasDatabaseUrl){
    console.warn('[DB.STATUS] DATABASE_URL definido pero no se pudo conectar:', st.error);
  } else {
    console.warn('[DB.STATUS] Sin DATABASE_URL: se usará fallback JSON');
  }
})();

app.use(compression());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || true, credentials:true }));
app.use(express.json({ limit:'1mb' }));
app.use(morgan('tiny'));
app.use(cookieParser());
try {
  const helmet = require('helmet');
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  }));
} catch(_) { console.warn('[SECURITY] helmet no instalado (ok en dev)'); }

// Ruta de archivos estáticos
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(uploadDir, { maxAge:'7d', immutable:false }));

// Utilidad: leer JSON local de respaldo
let localProductsCache = null;
function readLocalProducts() {
  if(!localProductsCache){
    const filePath = path.join(__dirname, 'data', 'products.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    localProductsCache = JSON.parse(raw).map(p=>({
      ...p,
      name: p.nombre,
      description: p.desc,
      image: p.img,
      price: p.precio
    }));
  }
  return localProductsCache;
}

function writeLocalProducts(list){
  try {
    const filePath = path.join(__dirname, 'data', 'products.json');
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    localProductsCache = list;
  } catch(e){
    console.warn('[FALLBACK.WRITE.ERROR]', e.message);
  }
}

// ===== FALLBACK USUARIOS (JSON local) =====
let localUsersCache = null;
function readLocalUsers() {
  if(!localUsersCache){
    try {
      const filePath = path.join(__dirname, 'data', 'users.json');
      if(!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify([], null, 2));
      const raw = fs.readFileSync(filePath, 'utf-8');
      localUsersCache = JSON.parse(raw);
    } catch(e){
      console.warn('[USERS.READ.ERROR]', e.message);
      localUsersCache = [];
    }
  }
  return [...localUsersCache];
}

function writeLocalUsers(list){
  try {
    const filePath = path.join(__dirname, 'data', 'users.json');
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    localUsersCache = list;
  } catch(e){
    console.warn('[USERS.WRITE.ERROR]', e.message);
  }
}

// Cache en memoria para resultados de /api/products (TTL configurable)
const PRODUCTS_TTL_MS = Number(process.env.PRODUCTS_TTL_MS || 30000);
let productCache = { at: 0, data: null, source: 'none' };

// Normaliza filas DB a la forma esperada en el frontend
function mapDbRow(r) {
  const precio = typeof r.precio === 'number' ? r.precio : Number(r.price || r.precio || 0);
  const obj = {
    id: r.id,
    nombre: r.nombre || r.name || '',
    desc: r.desc || r.descripcion || r.description || '',
    precio,
    img: r.img || r.image || 'assets/img/maceta1.png',
    thumb: r.thumb_img || r.thumb || null,
    categoria: r.categoria || r.category || 'otros',
    stock: typeof r.stock === 'number' ? r.stock : Number(r.stock || 0),
    min_stock: typeof r.min_stock === 'number' ? r.min_stock : Number(r.min_stock || 0)
  };
  // Duplicados para código legacy main.js que usa name, description, image, price
  obj.name = obj.nombre;
  obj.description = obj.desc;
  obj.image = obj.img;
  obj.price = obj.precio;
  if(obj.thumb) obj.thumb_url = obj.thumb;
  return obj;
}

// Asegura columnas nuevas (para servidores que no se reiniciaron tras despliegue)
async function ensureProductColumns(){
  if(!pool) return;
  try { await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INT NOT NULL DEFAULT 0'); } catch(_){ }
  try { await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS min_stock INT NOT NULL DEFAULT 0'); } catch(_){ }
  try { await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS thumb_img TEXT'); } catch(_){ }
}

app.get('/api/health', async (req, res) => {
  const health = { status: 'ok', db: false };
  if (pool) {
    try {
      await pool.query('SELECT 1');
      health.db = true;
    } catch (_) {}
  }
  res.json(health);
});

// Endpoint auxiliar para inspeccionar modo actual (útil para debugging de entorno)
app.get('/api/db-mode', async (req,res)=>{
  const st = await getDbStatus();
  res.json({
    mode: st.connected ? 'database' : 'fallback-json',
    hasDatabaseUrl: st.hasDatabaseUrl,
    connected: st.connected,
    error: st.error || null,
    nodeEnv: process.env.NODE_ENV || 'development'
  });
});

app.get('/api/products', async (req, res) => {
  await ensureProductColumns();
  // Parámetros: page, pageSize, q (búsqueda), categoria, sort(name|price|recent), dir (asc|desc)
  let { page=1, pageSize=200, q='', categoria='', sort='name', dir='asc' } = req.query;
  // Forzar no usar caché si viene parámetro __t (usado por el frontend para bust manual)
  const forceNoCache = typeof req.query.__t !== 'undefined';
  page = Math.max(1, parseInt(page));
  pageSize = Math.min(200, Math.max(1, parseInt(pageSize)));
  const now = Date.now();
  const useFilters = q || categoria || sort !== 'name' || page !== 1 || pageSize !== 200;
  if(forceNoCache){
    // Invalidar timestamp para evitar reutilizar la caché en este request puntual
    productCache.at = 0;
  }
  if(!forceNoCache && !useFilters && productCache.data && (now - productCache.at) < PRODUCTS_TTL_MS){
    res.set('X-Data-Source', productCache.source + '-cache');
    return res.json(productCache.data);
  }
  let data = [];
  let source = 'fallback-json';
  if (pool) {
    try {
      const filters = [];
      const params = [];
      let idx=1;
      if(q){
        filters.push(`(nombre ILIKE $${idx} OR "desc" ILIKE $${idx})`); params.push(`%${q}%`); idx++;
      }
      if(categoria){
        filters.push(`categoria ILIKE $${idx}`); params.push(categoria); idx++;
      }
      const whereSql = filters.length? 'WHERE '+filters.join(' AND '): '';
      const countSql = `SELECT COUNT(*)::int AS c FROM products ${whereSql}`;
      const countRows = await pool.query(countSql, params);
      const total = countRows.rows[0].c;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      if(page > totalPages) page = totalPages;
      const offset = (page-1)*pageSize;
      const sortCols = { name: 'nombre', price: 'precio', recent: 'created_at' };
      let sortCol = sortCols[sort] || 'nombre';
      if(sortCol==='created_at'){
        // si no existe la columna created_at en products se cae a nombre
        sortCol = 'nombre';
      }
      const dirSql = dir && dir.toLowerCase()==='desc' ? 'DESC':'ASC';
  const sql = `SELECT id, nombre, "desc" as desc, precio, img, thumb_img, categoria, stock, min_stock FROM products ${whereSql} ORDER BY ${sortCol} ${dirSql} LIMIT $${idx} OFFSET $${idx+1}`;
      const rows = (await pool.query(sql, [...params, pageSize, offset])).rows;
      data = rows.map(mapDbRow);
      source = 'database';
      if(!useFilters){
        productCache = { at: now, data, source };
      }
      res.set('X-Pagination', JSON.stringify({ page, pageSize, total, totalPages }));
    } catch (err) {
      // Code 42P01 => tabla no existe
      console.warn('[api/products] fallback JSON. Motivo:', err.code || err.message);
      data = readLocalProducts();
    }
  } else {
    data = readLocalProducts();
  }
  if(!useFilters){
    res.set('X-Data-Source', source);
    res.set('Cache-Control', 'public, max-age=30');
  } else {
    res.set('X-Data-Source', source + (useFilters?'-nofullcache':''));
  }
  return res.json(data);
});

// ===== CRUD Productos (inventario) =====
// Listado ya existe arriba (GET /api/products) sin auth para tienda.
// Para crear/editar/borrar requerimos autenticación y rol editor/admin.

function requireEditor(req,res,next){
  if(!req.user || !['admin','editor'].includes(req.user.role)) return res.status(403).json({ error:'Requiere rol editor o admin'});
  next();
}

app.post('/api/products', authMiddleware, requireEditor, async (req,res)=>{
  await ensureProductColumns();
  // Aceptar alias de campos (por si el formulario no envía exactamente 'img' o 'thumb')
  let { id, nombre, desc, precio, img, image, imagen, image_url, thumb, thumb_img, thumbnail, categoria, stock, min_stock } = req.body || {};
  img = img || image || imagen || image_url || '';
  thumb = thumb || thumb_img || thumbnail || null;
  if(!nombre || typeof precio === 'undefined') return res.status(400).json({ error:'Campos requeridos: nombre, precio' });
  if(!pool){
    try {
      const list = readLocalProducts().slice();
      const pid = id || randomUUID();
      const priceNum = Number(precio)||0;
      const stockNum = Math.max(0, Number(stock)||0);
      const minStockNum = Math.max(0, Number(min_stock)||0);
      const prod = { id: pid, nombre, desc: desc||'', precio: priceNum, img: img||'assets/img/maceta1.png', thumb: thumb||null, categoria: categoria||'otros', stock: stockNum, min_stock: minStockNum };
      list.unshift(prod);
      writeLocalProducts(list);
      console.log('[PRODUCT.CREATE.FALLBACK]', { id: prod.id, img: prod.img, thumb: prod.thumb||null });
      res.set('Cache-Control','no-store');
      res.status(201).json(prod);
      broadcast('product.upsert', prod);
      return;
    } catch(e){
      console.error('[PRODUCT.CREATE.FALLBACK.ERROR]', e.message);
      return res.status(500).json({ error:'Error creando (fallback)' });
    }
  }
  try {
    const pid = id || randomUUID();
    const priceNum = Number(precio)||0;
    const stockNum = Math.max(0, Number(stock)||0);
    const minStockNum = Math.max(0, Number(min_stock)||0);
    console.log('[PRODUCT.CREATE.REQUEST]', { rawBody: req.body, resolved: { nombre, precio: priceNum, img, thumb } });
    await pool.query('INSERT INTO products (id, nombre, "desc", precio, img, thumb_img, categoria, stock, min_stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET nombre=EXCLUDED.nombre, "desc"=EXCLUDED."desc", precio=EXCLUDED.precio, img=EXCLUDED.img, thumb_img=EXCLUDED.thumb_img, categoria=EXCLUDED.categoria, stock=EXCLUDED.stock, min_stock=EXCLUDED.min_stock', [pid, nombre, desc||'', priceNum, img||'', thumb||null, categoria||'otros', stockNum, minStockNum]);
    productCache = { at:0, data:null, source:'none' }; // invalidar cache
    const { rows } = await pool.query('SELECT id, nombre, "desc" as desc, precio, img, thumb_img, categoria, stock, min_stock FROM products WHERE id=$1',[pid]);
    const prod = rows.length? mapDbRow(rows[0]) : { id: pid, nombre, desc: desc||'', precio: priceNum, img: img||'', thumb: thumb||null, categoria: categoria||'otros', stock: stockNum, min_stock: minStockNum };
    console.log('[PRODUCT.CREATE]', { id: prod.id, img: prod.img, thumb: prod.thumb || null });
    res.set('Cache-Control','no-store');
    res.status(201).json(prod);
    broadcast('product.upsert', prod);
  } catch(e){
    console.error('Error create product:', e.message); res.status(500).json({ error:'Error interno' });
  }
});

app.patch('/api/products/:id', authMiddleware, requireEditor, async (req,res)=>{
  await ensureProductColumns();
  if(!pool){
    const { id } = req.params;
    const { nombre, desc, precio, img, thumb, categoria, stock, min_stock } = req.body||{};
    try {
      const list = readLocalProducts().slice();
      const idx = list.findIndex(p=> p.id === id);
      if(idx === -1) return res.status(404).json({ error:'No encontrado' });
      const p = list[idx];
      if(typeof nombre !== 'undefined') p.nombre = nombre;
      if(typeof desc !== 'undefined') p.desc = desc;
      if(typeof precio !== 'undefined') p.precio = Number(precio)||0;
      if(typeof img !== 'undefined') p.img = img || p.img;
      if(typeof thumb !== 'undefined') p.thumb = thumb || null;
      if(typeof categoria !== 'undefined') p.categoria = categoria || 'otros';
      if(typeof stock !== 'undefined') p.stock = Math.max(0, Number(stock)||0);
      if(typeof min_stock !== 'undefined') p.min_stock = Math.max(0, Number(min_stock)||0);
      writeLocalProducts(list);
      res.json(p);
      broadcast('product.upsert', p);
      return;
    } catch(e){
      console.error('[PRODUCT.PATCH.FALLBACK.ERROR]', e.message);
      return res.status(500).json({ error:'Error actualizando (fallback)' });
    }
  }
  const { id } = req.params; const { nombre, desc, precio, img, thumb, categoria, stock, min_stock } = req.body||{};
  if(!nombre && typeof precio === 'undefined' && typeof desc === 'undefined' && typeof img === 'undefined' && typeof thumb === 'undefined' && typeof categoria === 'undefined' && typeof stock === 'undefined' && typeof min_stock === 'undefined') return res.status(400).json({ error:'Nada para actualizar' });
  try {
    // construir dinámico
    const fields=[]; const params=[]; let idx=1;
    if(nombre){ fields.push(`nombre=$${idx++}`); params.push(nombre); }
    if(typeof desc !== 'undefined'){ fields.push(`"desc"=$${idx++}`); params.push(desc); }
    if(typeof precio !== 'undefined'){ fields.push(`precio=$${idx++}`); params.push(Number(precio)||0); }
    if(typeof img !== 'undefined'){ fields.push(`img=$${idx++}`); params.push(img); }
    if(typeof thumb !== 'undefined'){ fields.push(`thumb_img=$${idx++}`); params.push(thumb||null); }
  if(typeof categoria !== 'undefined'){ fields.push(`categoria=$${idx++}`); params.push(categoria||'otros'); }
  if(typeof stock !== 'undefined'){ fields.push(`stock=$${idx++}`); params.push(Math.max(0, Number(stock)||0)); }
  if(typeof min_stock !== 'undefined'){ fields.push(`min_stock=$${idx++}`); params.push(Math.max(0, Number(min_stock)||0)); }
    params.push(id);
  const sql = `UPDATE products SET ${fields.join(', ')} WHERE id=$${idx} RETURNING id, nombre, "desc" as desc, precio, img, thumb_img, categoria, stock, min_stock`;
    const { rows } = await pool.query(sql, params);
    if(!rows.length) return res.status(404).json({ error:'No encontrado' });
    productCache = { at:0, data:null, source:'none' };
    const prod = mapDbRow(rows[0]);
    res.json(prod);
    broadcast('product.upsert', prod);
  } catch(e){ console.error('Error patch product:', e.message); res.status(500).json({ error:'Error interno' }); }
});

app.delete('/api/products/:id', authMiddleware, requireEditor, async (req,res)=>{
  await ensureProductColumns();
  const { id } = req.params;
  const hintedPublicId = req.headers['x-cloudinary-publicid'] ? String(req.headers['x-cloudinary-publicid']) : null;

  // --- Fallback (sin DB) ---
  if(!pool){
    try {
      const list = readLocalProducts().slice();
      const prod = list.find(p=> p.id === id);
      if(!prod) return res.status(404).json({ error:'No encontrado' });
      const newList = list.filter(p=> p.id !== id);
      writeLocalProducts(newList);
      // Intentar eliminar imagen en Cloudinary si aplica
      if(useCloudinary && cloudinary && prod.img){
        const pubId = hintedPublicId || extractCloudinaryPublicId(prod.img);
        if(pubId){
          cloudinary.uploader.destroy(pubId, { invalidate:true }, (err, result)=>{
            if(err) console.warn('[CLOUDINARY.DESTROY.FALLBACK.ERROR]', pubId, err.message);
            else console.log('[CLOUDINARY.DESTROY.FALLBACK]', pubId, result?.result);
          });
        }
      }
      console.log('[PRODUCT.DELETE.FALLBACK]', id);
      res.json({ ok:true });
      broadcast('product.delete', { id });
      return;
    } catch(e){
      console.error('[PRODUCT.DELETE.FALLBACK.ERROR]', e.message);
      return res.status(500).json({ error:'Error eliminando (fallback)' });
    }
  }

  // --- Modo DB ---
  try {
    // Borrar retornando columnas para intentar limpieza Cloudinary
    const { rows } = await pool.query('DELETE FROM products WHERE id=$1 RETURNING img, thumb_img',[id]);
    if(!rows.length) return res.status(404).json({ error:'No encontrado' });
    const deleted = rows[0];
    if(useCloudinary && cloudinary && deleted.img){
      const pubId = hintedPublicId || extractCloudinaryPublicId(deleted.img);
      if(pubId){
        cloudinary.uploader.destroy(pubId, { invalidate:true }, (err, result)=>{
          if(err) console.warn('[CLOUDINARY.DESTROY.DB.ERROR]', pubId, err.message);
          else console.log('[CLOUDINARY.DESTROY.DB]', pubId, result?.result);
        });
      }
    }
    productCache={at:0,data:null,source:'none'};
    res.json({ ok:true });
    broadcast('product.delete', { id });
  } catch(e){
    console.error('Error delete product:', e.message);
    res.status(500).json({ error:'Error interno' });
  }
});

// Endpoint para depurar configuración (sin exponer secretos completos)
app.get('/api/config', (req,res)=>{
  res.json({
    env: process.env.NODE_ENV || 'development',
    hasDatabaseUrl: !!process.env.DATABASE_URL,
    render: !!process.env.RENDER,
    service: process.env.RENDER_SERVICE_NAME || null,
    commit: process.env.RENDER_GIT_COMMIT || null,
    seeded: !!process.env.SEED_ON_START,
    productsCacheAgeMs: productCache.data ? (Date.now() - productCache.at) : null
  });
});

// Estado de Cloudinary (requiere editor). Permite verificar configuración y límites.
app.get('/api/cloudinary/status', authMiddleware, requireEditor, async (req,res)=>{
  const enabled = !!(useCloudinary && cloudinary);
  const method = enabled ? (hasCloudinaryDirect ? 'vars' : 'url') : null;
  const folder = enabled ? (process.env.CLOUDINARY_FOLDER || null) : null;
  const info = {
    enabled,
    method,
    folder,
    rateLimit: { windowMs: UPLOAD_WINDOW_MS, max: UPLOAD_MAX },
    timestamp: Date.now(),
    canUpload: false,
    error: null
  };
  if(!enabled) return res.json(info);
  // Ping opcional (salta si ?ping=0)
  if(String(req.query.ping) === '0') return res.json(info);
  try {
    const pingRes = await new Promise((resolve, reject)=>{
      if(!cloudinary?.api?.ping) return resolve({ status:'skipped' });
      cloudinary.api.ping((err, resPing)=> err? reject(err): resolve(resPing));
      setTimeout(()=> reject(new Error('timeout')), 2500);
    });
    info.canUpload = true;
    info.ping = pingRes.status || 'ok';
  } catch(e){
    info.error = e.message;
  }
  res.json(info);
});

// Listar movimientos de stock (admin)
app.get('/api/stock-movements', authMiddleware, requireAdmin, async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  let { page=1, pageSize=50, productId, from, to } = req.query;
  page = Math.max(1, parseInt(page));
  pageSize = Math.min(200, Math.max(1, parseInt(pageSize)));
  try {
    const filters=[]; const params=[]; let idx=1;
    if(productId){ filters.push(`product_id=$${idx++}`); params.push(productId); }
    if(from){ filters.push(`created_at >= $${idx++}`); params.push(from); }
    if(to){ filters.push(`created_at <= $${idx++}`); params.push(to); }
    const whereSql = filters.length? 'WHERE '+filters.join(' AND '): '';
    const countSql = `SELECT COUNT(*)::int AS c FROM stock_movements ${whereSql}`;
    const { rows: cRows } = await pool.query(countSql, params);
    const total = cRows[0].c; const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if(page>totalPages) page = totalPages;
    const offset = (page-1)*pageSize;
    const dataSql = `SELECT id, product_id, delta, previous_stock, new_stock, reason, user_id, created_at FROM stock_movements ${whereSql} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    const rows = (await pool.query(dataSql, [...params, pageSize, offset])).rows;
    res.json({ items: rows, page, pageSize, total, totalPages });
  } catch(e){ console.error('movements list:', e.message); res.status(500).json({ error:'Error interno' }); }
});

// Export CSV movimientos
app.get('/api/stock-movements/export.csv', authMiddleware, requireAdmin, async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible'});
  try {
    const { rows } = await pool.query('SELECT sm.created_at, sm.product_id, p.nombre, sm.delta, sm.previous_stock, sm.new_stock, sm.reason FROM stock_movements sm LEFT JOIN products p ON p.id=sm.product_id ORDER BY sm.created_at DESC LIMIT 2000');
    const headers = ['fecha','product_id','nombre','delta','previo','nuevo','motivo'];
    const lines = [headers.join(',')].concat(rows.map(r=>[
      r.created_at.toISOString(),
      r.product_id,
      (r.nombre||'').replace(/,/g,' '),
      r.delta,
      r.previous_stock,
      r.new_stock,
      r.reason
    ].join(',')));
    res.set('Content-Type','text/csv');
    res.set('Content-Disposition','attachment; filename="stock_movements.csv"');
    res.send(lines.join('\n'));
  } catch(e){ res.status(500).json({ error:'Error exportando'}); }
});

// Subida de imágenes producto (validación + miniatura)
app.post('/api/products/upload-image', authMiddleware, requireEditor, uploadLimiter, upload.single('image'), async (req,res)=>{
  const traceId = Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
  try {
    if(!req.file){
      console.warn('[UPLOAD.NOFILE]', traceId);
      return res.status(400).json({ error:'Archivo requerido', traceId });
    }
    const file = req.file;
    const maxBytes = 3 * 1024 * 1024; // 3MB
    if(file.size > maxBytes){
      console.warn('[UPLOAD.TOO_BIG]', traceId, file.size);
      return res.status(400).json({ error:'Máximo 3MB', traceId });
    }
    const allowed = ['image/jpeg','image/png','image/webp','image/avif'];
    if(!allowed.includes(file.mimetype)){
      console.warn('[UPLOAD.BAD_MIME]', traceId, file.mimetype);
      return res.status(415).json({ error:'Formato no permitido', traceId });
    }
    res.set('X-Trace-Id', traceId);

    // Si Cloudinary está habilitado subimos en streaming desde buffer
    if(useCloudinary && cloudinary){
      const folder = process.env.CLOUDINARY_FOLDER || 'growshop';
      const publicIdBase = 'prod_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
      // Subida principal
      const uploadMain = ()=> new Promise((resolve, reject)=>{
        const stream = cloudinary.uploader.upload_stream({
          folder,
          public_id: publicIdBase,
          resource_type: 'image'
        }, (err, result)=> err? reject(err): resolve(result));
        stream.end(file.buffer);
      });
      let mainResult;
      try { mainResult = await uploadMain(); } catch(e){
        console.error('[CLOUDINARY.UPLOAD.ERROR]', traceId, e.message);
        return res.status(500).json({ error:'Fallo subiendo a Cloudinary', detail:e.message, traceId });
      }
      // Generar URL optimizada y miniatura (transformaciones en URL, no necesitamos archivo físico extra)
      const secureUrl = mainResult.secure_url;
      // thumb 340x340 recorte centrado (auto gravity)
      const thumbUrl = cloudinary.url(mainResult.public_id, {
        transformation: [
          { width: 340, height: 340, crop: 'fill', gravity: 'auto', quality: 'auto', fetch_format: 'auto' }
        ],
        secure: true,
        version: mainResult.version,
        folder
      });
      console.log('[UPLOAD.IMAGE.CLOUDINARY]', traceId, { id: mainResult.public_id, bytes: mainResult.bytes, format: mainResult.format });
      res.set('Cache-Control','no-store');
      res.set('X-Image-Provider','cloudinary');
      return res.status(201).json({
        provider: 'cloudinary',
        url: secureUrl,          // campo usado por el form (img)
        absolute: secureUrl,     // compatibilidad con lógica existente en admin.js
        thumb: { url: thumbUrl, absolute: thumbUrl },
        public_id: mainResult.public_id,
        width: mainResult.width,
        height: mainResult.height,
        bytes: mainResult.bytes,
        format: mainResult.format,
        traceId
      });
    }

    // Modo local (fallback)
    if(cloudinaryOnly && !(useCloudinary && cloudinary)){
      console.error('[UPLOAD.CLOUDINARY_ONLY.NO_CONFIG]', traceId);
      return res.status(500).json({ error:'Cloudinary obligatorio: configure credenciales', traceId });
    }
    if(!file.filename){
      // Si usamos memoryStorage pero sin Cloudinary (config incompleta) necesitamos persistir manualmente
      const ext = file.originalname ? path.extname(file.originalname) : '.bin';
      const fname = Date.now()+'-'+Math.random().toString(36).slice(2)+ext;
      fs.writeFileSync(path.join(uploadDir, fname), file.buffer);
      file.filename = fname;
      file.path = path.join(uploadDir, fname);
    }
    let thumbRel = null;
    try {
      const sharp = require('sharp');
      const base = file.filename.replace(/(\.[a-z0-9]+)$/i, '');
      const outName = base + '_thumb.webp';
      const fullPath = path.join(uploadDir, outName);
      await sharp(file.path)
        .resize(340, 340, { fit:'cover' })
        .webp({ quality:80 })
        .toFile(fullPath);
      thumbRel = '/uploads/' + outName;
    } catch(thErr){ console.warn('sharp thumbnail fail:', thErr.message); }
    const rel = '/uploads/'+file.filename;
    const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    console.log('[UPLOAD.IMAGE.LOCAL]', traceId, { file: rel, thumb: thumbRel, size: file.size, type: file.mimetype });
    res.set('Cache-Control','no-store');
    res.set('X-Image-Provider','local');
    res.status(201).json({ provider:'local', url: rel, absolute: baseUrl + rel, thumb: thumbRel ? { url: thumbRel, absolute: baseUrl + thumbRel } : null, traceId });
  } catch(e){ console.error('upload-image error:', traceId, e); res.status(500).json({ error:'Error subiendo', traceId, detail:e.message }); }
});

// ====== IMÁGENES HUÉRFANAS (ADMIN) ======
app.get('/api/uploads/orphans', authMiddleware, requireAdmin, async (req,res)=>{
  try {
    const files = fs.readdirSync(uploadDir).filter(f=> !f.startsWith('.'));
    if(!pool) return res.json({ orphans: files.map(f=>({ file:f, size: fs.statSync(path.join(uploadDir,f)).size })) });
    await ensureProductColumns();
    const { rows } = await pool.query('SELECT img, thumb_img FROM products');
    const used = new Set();
    for(const r of rows){ if(r.img) used.add(path.basename(r.img)); if(r.thumb_img) used.add(path.basename(r.thumb_img)); }
    const orphans = [];
    for(const f of files){ if(!used.has(f)){ const st = fs.statSync(path.join(uploadDir,f)); orphans.push({ file:f, size: st.size, mtime: st.mtime }); } }
    res.json({ count: orphans.length, orphans });
  } catch(e){ res.status(500).json({ error:'Error listando', detail:e.message }); }
});

app.delete('/api/uploads/orphans/:file', authMiddleware, requireAdmin, async (req,res)=>{
  const fname = req.params.file;
  if(!/^[a-zA-Z0-9_.\-]+$/.test(fname)) return res.status(400).json({ error:'Nombre inválido' });
  try {
    const target = path.join(uploadDir, fname);
    if(!fs.existsSync(target)) return res.status(404).json({ error:'No existe' });
    if(pool){
      const { rows } = await pool.query('SELECT 1 FROM products WHERE img LIKE $1 OR thumb_img LIKE $1 LIMIT 1',[`%${fname}`]);
      if(rows.length) return res.status(409).json({ error:'Archivo en uso' });
    }
    fs.unlinkSync(target);
    res.json({ ok:true, deleted: fname });
  } catch(e){ res.status(500).json({ error:'Error eliminando', detail:e.message }); }
});

// Resumen rápido de inventario
app.get('/api/products/summary', authMiddleware, async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  try {
    await ensureProductColumns();
    const statsSql = `SELECT
        COUNT(*)::int AS total_products,
        COALESCE(SUM(stock),0)::int AS total_units,
        COALESCE(SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END),0)::int AS out_of_stock,
        COALESCE(SUM(CASE WHEN stock > 0 AND stock <= min_stock AND min_stock > 0 THEN 1 ELSE 0 END),0)::int AS low_stock
      FROM products`;
    const { rows: statRows } = await pool.query(statsSql);
    const stats = statRows[0];
    const { rows: recent } = await pool.query('SELECT sm.id, sm.product_id, p.nombre, sm.delta, sm.previous_stock, sm.new_stock, sm.reason, sm.created_at FROM stock_movements sm LEFT JOIN products p ON p.id=sm.product_id ORDER BY sm.created_at DESC LIMIT 6');
    const topLow = (await pool.query('SELECT id, nombre, stock, min_stock FROM products WHERE stock > 0 AND stock <= min_stock AND min_stock > 0 ORDER BY stock ASC LIMIT 5')).rows;
    const topOut = (await pool.query('SELECT id, nombre, stock FROM products WHERE stock <= 0 ORDER BY nombre ASC LIMIT 5')).rows;
    // sparkline: estimación simple: snapshot actual distribuido (placeholder) si no hay movimientos suficientes
    const days = 7;
    const daily = [];
    // Reconstruir stock histórico aproximado usando movimientos (restando hacia atrás)
    const moveRows = await pool.query('SELECT product_id, delta, created_at FROM stock_movements ORDER BY created_at DESC LIMIT 500');
    // Mapa fecha -> ajuste
    const today = new Date(); today.setHours(0,0,0,0);
    const perDay = Array.from({length:days}).map((_,i)=>{
      const d = new Date(today); d.setDate(d.getDate() - (days-1-i)); return { day: d, delta:0 };
    });
    for(const m of moveRows.rows){
      const d = new Date(m.created_at); d.setHours(0,0,0,0);
      const slot = perDay.find(x=> x.day.getTime() === d.getTime());
      if(slot) slot.delta += m.delta;
    }
    // Partimos del stock actual total y retrocedemos aplicando delta inversa
    let running = stats.total_units;
    for(let i=perDay.length-1;i>=0;i--){
      running -= perDay[i].delta; // delta es lo que ocurrió ese día
      daily.unshift(Math.max(0,running));
    }
    const spark = daily.map(v=>Number(v)).slice(-days);
    res.json({
      stats: {
        totalProducts: stats.total_products,
        totalUnits: stats.total_units,
        outOfStock: stats.out_of_stock,
        lowStock: stats.low_stock
      },
      lowStockProducts: topLow,
      outOfStockProducts: topOut,
      recentMovements: recent,
      sparkline: spark
    });
  } catch(e){
    console.error('summary error:', e.message);
    res.status(500).json({ error:'Error interno' });
  }
});

// Fallback SPA / páginas estáticas (sirve index si la ruta no existe y no es API)
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  const fileRequested = path.join(__dirname, req.path);
  if (fs.existsSync(fileRequested) && fs.statSync(fileRequested).isFile()) {
    return res.sendFile(fileRequested);
  }
  return res.sendFile(path.join(__dirname, 'index.html'));
});

// Inicio con tolerancia a puerto en uso (solo local). Si PORT viene del entorno (Render) no se reintenta.
async function migrateAndSeedIfNeeded(){
  if(!pool) return;
  try {
    // Extensión antes de tablas que la usan
  // Eliminamos dependencia fuerte de extensiones para UUID de sales: generaremos en Node.

    await pool.query(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      "desc" TEXT,
      precio NUMERIC(10,2) NOT NULL DEFAULT 0,
      img TEXT,
      categoria TEXT,
      stock INT NOT NULL DEFAULT 0,
      min_stock INT NOT NULL DEFAULT 0
    );`);
    // Asegurar columnas nuevas en despliegues existentes
    try { await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INT NOT NULL DEFAULT 0'); } catch(_){ }
    try { await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS min_stock INT NOT NULL DEFAULT 0'); } catch(_){ }

    await pool.query(`CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
      delta INT NOT NULL,
      previous_stock INT NOT NULL,
      new_stock INT NOT NULL,
      reason TEXT NOT NULL,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);

    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);

    await pool.query(`CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      items JSONB NOT NULL,
      total NUMERIC(10,2) NOT NULL DEFAULT 0,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'pendiente',
      notes TEXT
    );`);

    await pool.query(`CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details JSONB
    );`);

    // Crear usuario admin inicial si se define en entorno y no existe
    if(process.env.ADMIN_USER && process.env.ADMIN_PASS){
      try {
        const existing = await pool.query('SELECT 1 FROM users WHERE username=$1 LIMIT 1',[process.env.ADMIN_USER]);
        if(!existing.rowCount){
          const hash = await bcrypt.hash(process.env.ADMIN_PASS, 10);
            await pool.query('INSERT INTO users (username, password_hash) VALUES ($1,$2)',[process.env.ADMIN_USER, hash]);
          console.log('Usuario admin inicial creado.');
        }
      } catch(e){
        console.warn('No se pudo crear usuario admin inicial:', e.message);
      }
    }

    if(process.env.SEED_ON_START){
      const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM products');
      const count = rows[0].c;
      if(count === 0){
        const products = readLocalProducts();
  const text = 'INSERT INTO products (id, nombre, "desc", precio, img, categoria, stock, min_stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET nombre=EXCLUDED.nombre, "desc"=EXCLUDED."desc", precio=EXCLUDED.precio, img=EXCLUDED.img, categoria=EXCLUDED.categoria, stock=EXCLUDED.stock, min_stock=EXCLUDED.min_stock';
        for(const p of products){
          await pool.query(text,[p.id, p.nombre, p.desc, p.precio, p.img, p.categoria, p.stock || 0, p.min_stock || 0]);
        }
        console.log(`Seed completado: ${products.length} productos insertados.`);
      } else {
        console.log(`Seed omitido: la tabla products ya tiene ${count} registros.`);
      }
    }
  } catch (e){
    console.error('Error en migraciones:', e.message);
  }
}

function startServer(port, attempt = 0){
  const isFixed = !!process.env.PORT && String(process.env.PORT) === String(port);
  const server = app.listen(port, () => {
    console.log(`Servidor escuchando en puerto ${port}${attempt>0 ? ' (fallback)' : ''}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (isFixed) {
        console.error(`El puerto ${port} está en uso y está fijado por el entorno. Abortando.`);
        process.exit(1);
      }
      if (attempt < 5) {
        const nextPort = port + 1;
        console.warn(`Puerto ${port} en uso. Reintentando con ${nextPort}...`);
        setTimeout(()=> startServer(nextPort, attempt + 1), 300);
      } else {
        console.error('No se pudo encontrar un puerto libre tras varios intentos.');
        process.exit(1);
      }
    } else {
      console.error('Error al iniciar el servidor:', err);
      process.exit(1);
    }
  });
}

(async ()=>{
  await migrateAndSeedIfNeeded();
  await ensureRoleColumn();
  startServer(Number(PORT));
})();

// ================== AUTH, ROLES & SALES ==================
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change';
const JWT_TTL = process.env.JWT_EXPIRES_IN || '2h';
const VALID_ROLES = ['admin','editor','viewer'];
// Limitador básico de intentos de login (memoria)
const loginAttempts = new Map(); // key -> { count, lockUntil }
const MAX_ATTEMPTS = 5;
const LOCK_WINDOW_MS = 30_000; // 30s
function loginKey(req, username){
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'ip';
  return `${username || 'nouser'}|${ip}`;
}
function loginLocked(req, username){
  const k = loginKey(req, username); const e = loginAttempts.get(k);
  if(e && e.lockUntil && Date.now() < e.lockUntil){
    return { locked:true, remaining: Math.ceil((e.lockUntil - Date.now())/1000) };
  }
  return { locked:false };
}
function loginFail(req, username){
  const k = loginKey(req, username); const e = loginAttempts.get(k) || { count:0, lockUntil:0 };
  e.count += 1;
  if(e.count >= MAX_ATTEMPTS){ e.lockUntil = Date.now() + LOCK_WINDOW_MS; e.count = 0; }
  loginAttempts.set(k, e);
}
function loginOk(req, username){ loginAttempts.delete(loginKey(req, username)); }

async function ensureRoleColumn(){
  if(!pool) return;
  try {
    const { rows } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='role'");
    if(rows.length === 0){
      await pool.query("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
      // Si hay más de un usuario, sólo el primero se queda como admin y los demás pasan a viewer
      const existing = await pool.query('SELECT id FROM users ORDER BY created_at ASC');
      if(existing.rowCount > 1){
        const firstId = existing.rows[0].id;
        await pool.query("UPDATE users SET role='viewer' WHERE id <> $1", [firstId]);
        await pool.query("UPDATE users SET role='admin' WHERE id=$1", [firstId]);
      }
      console.log('Columna role añadida a users');
    }
  } catch(e){
    console.warn('No se pudo asegurar columna role:', e.message);
  }
}

function signToken(user){
  return jwt.sign({ uid: user.id, username: user.username, role: user.role || 'admin' }, JWT_SECRET, { expiresIn: JWT_TTL });
}

function ttlToMs(ttl){
  // acepta formatos como 2h, 30m, 15s, número en segundos
  if(!ttl) return 2*60*60*1000;
  if(/^[0-9]+$/.test(ttl)) return Number(ttl)*1000;
  const m = ttl.match(/^(\d+)([smhd])$/i);
  if(!m) return 2*60*60*1000;
  const num = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit==='s'?1000: unit==='m'?60*1000: unit==='h'?60*60*1000: 24*60*60*1000;
  return num*mult;
}
const TOKEN_MAX_AGE = ttlToMs(JWT_TTL);

async function logAudit(userId, action, targetType, targetId, details){
  if(!pool) return;
  try {
    await pool.query('INSERT INTO audits (id, user_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), userId || null, action, targetType || null, targetId || null, details ? JSON.stringify(details) : null]);
  } catch(e){
    console.warn('No se pudo registrar auditoría:', e.message);
  }
}

// ================== SSE (Server-Sent Events) ==================
const sseClients = new Set();

function broadcast(event, data){
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for(const res of sseClients){
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${payload}\n\n`);
    } catch(_){ /* ignorar broker roto */ }
  }
}

app.get('/api/stream', authMiddleware, (req,res)=>{
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', ()=> sseClients.delete(res));
});

// Heartbeat para mantener vivas conexiones (cada 25s)
setInterval(()=>{
  for(const res of sseClients){
    try { res.write(`: hb ${Date.now()}\n\n`); } catch(_){ }
  }
}, 25000);

function authMiddleware(req,res,next){
  const token = req.cookies?.token || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  if(!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch(e){
    return res.status(401).json({ error: 'Token inválido' });
  }
}

function requireAdmin(req,res,next){
  if(!req.user || req.user.role !== 'admin') return res.status(403).json({ error:'Requiere rol admin' });
  next();
}

function canEditSales(req){
  return req.user && (req.user.role === 'admin' || req.user.role === 'editor');
}

// Endpoint para saber si el registro está habilitado (ALLOW_REGISTER o 0 usuarios)
app.get('/api/auth/register-enabled', async (req,res)=>{
  if(!pool) return res.json({ allow:false, reason:'DB no disponible' });
  try {
    const totalUsersRow = await pool.query('SELECT COUNT(*)::int AS c FROM users');
    const adminsRow = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role='admin'");
    const totalUsers = totalUsersRow.rows[0].c;
    const adminCount = adminsRow.rows[0].c;
    // Permitir registro si:
    //  - variable ALLOW_REGISTER está activa OR
    //  - no hay usuarios aún OR
    //  - hay menos de 2 administradores (queremos que exista un segundo admin)
    const allow = !!process.env.ALLOW_REGISTER || totalUsers === 0 || adminCount < 2;
    res.json({ allow, users: totalUsers, adminCount, adminSlotsRemaining: Math.max(0, 2 - adminCount) });
  } catch(e){
    res.json({ allow:false, error:e.message });
  }
});

// Registro: permitido si ALLOW_REGISTER o no existen usuarios aún
app.post('/api/auth/register', async (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password) return res.status(400).json({ error:'Faltan campos' });
  try {
    // MODO FALLBACK (sin BD)
    if(!pool){
      const users = readLocalUsers();
      const totalUsers = users.length;
      const adminCount = users.filter(u=> u.role==='admin').length;
      const allow = !!process.env.ALLOW_REGISTER || totalUsers === 0 || adminCount < 2;
      if(!allow) return res.status(403).json({ error:'Registro deshabilitado' });
      
      // Verificar si usuario ya existe
      if(users.some(u=> u.username === username)){
        return res.status(409).json({ error:'Usuario ya existe' });
      }
      
      const hash = await bcrypt.hash(password, 10);
      let role = (adminCount < 2) ? 'admin' : 'viewer';
      if(totalUsers === 0) role = 'admin';
      
      const newUser = {
        id: totalUsers > 0 ? Math.max(...users.map(u=> u.id)) + 1 : 1,
        username,
        password_hash: hash,
        role,
        created_at: new Date().toISOString()
      };
      
      users.push(newUser);
      writeLocalUsers(users);
      
      const userObj = { id: newUser.id, username: newUser.username, role: newUser.role };
      const token = signToken(userObj);
      res.cookie('token', token, { httpOnly:true, sameSite:'lax', secure: !!process.env.RENDER || process.env.NODE_ENV==='production', maxAge: TOKEN_MAX_AGE });
      res.status(201).json({ user: userObj, token, adminSlotsRemaining: Math.max(0, 2 - (role==='admin'? adminCount+1: adminCount)) });
      console.log('[AUTH.REGISTER.FALLBACK]', username, role);
      return;
    }
    
    // MODO BD
    const totalUsersRow = await pool.query('SELECT COUNT(*)::int AS c FROM users');
    const adminsRow = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role='admin'");
    const totalUsers = totalUsersRow.rows[0].c;
    const adminCount = adminsRow.rows[0].c;
    const allow = !!process.env.ALLOW_REGISTER || totalUsers === 0 || adminCount < 2;
    if(!allow) return res.status(403).json({ error:'Registro deshabilitado' });
    const hash = await bcrypt.hash(password, 10);
    // Rol asignado: admin si todavía hay menos de 2 admins, si no viewer
    let role = (adminCount < 2) ? 'admin' : 'viewer';
    // fallback inicial si no hay usuarios todavía, permanece admin
    if(totalUsers === 0) role = 'admin';
    let rows;
    try {
      const ins = await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id, username, role', [username, hash, role]);
      rows = ins.rows;
    } catch(e){
      if(e.message.includes('column') && e.message.includes('role')){
        const fallback = await pool.query('INSERT INTO users (username, password_hash) VALUES ($1,$2) RETURNING id, username', [username, hash]);
        rows = fallback.rows.map(r=>({...r, role: role }));
      } else { throw e; }
    }
    const userObj = rows[0];
    const token = signToken(userObj);
  res.cookie('token', token, { httpOnly:true, sameSite:'lax', secure: !!process.env.RENDER || process.env.NODE_ENV==='production', maxAge: TOKEN_MAX_AGE });
    res.status(201).json({ user: userObj, token, adminSlotsRemaining: Math.max(0, 2 - (role==='admin'? adminCount+1: adminCount)) });
    await logAudit(userObj.id, 'user.register', 'user', String(userObj.id), { username, role:userObj.role });
    broadcast('user.create', { id: userObj.id, username: userObj.username, role: userObj.role });
  } catch(e){
    if(e.code === '23505') return res.status(409).json({ error:'Usuario ya existe' });
    console.error('Error register:', e.message);
    res.status(500).json({ error:'Error interno' });
  }
});

app.post('/api/auth/login', async (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password) return res.status(400).json({ error:'Faltan credenciales' });
  const ls = loginLocked(req, username);
  if(ls.locked) return res.status(429).json({ error:`Bloqueado temporalmente. Reintenta en ${ls.remaining}s` });
  try {
    // MODO FALLBACK (sin BD)
    if(!pool){
      const users = readLocalUsers();
      const user = users.find(u=> u.username === username);
      if(!user){ loginFail(req, username); return res.status(401).json({ error:'Credenciales inválidas' }); }
      const ok = await bcrypt.compare(password, user.password_hash);
      if(!ok){ loginFail(req, username); return res.status(401).json({ error:'Credenciales inválidas' }); }
      loginOk(req, username);
      const token = signToken(user);
      res.cookie('token', token, { httpOnly:true, sameSite:'lax', secure: !!process.env.RENDER || process.env.NODE_ENV==='production', maxAge: TOKEN_MAX_AGE });
      res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
      console.log('[AUTH.LOGIN.FALLBACK]', username, user.role);
      return;
    }
    
    // MODO BD
    await ensureRoleColumn();
    const { rows } = await pool.query('SELECT id, username, password_hash, role FROM users WHERE username=$1', [username]);
    if(!rows.length){ loginFail(req, username); return res.status(401).json({ error:'Credenciales inválidas' }); }
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if(!ok){ loginFail(req, username); return res.status(401).json({ error:'Credenciales inválidas' }); }
    loginOk(req, username);
    const token = signToken(user);
  res.cookie('token', token, { httpOnly:true, sameSite:'lax', secure: !!process.env.RENDER || process.env.NODE_ENV==='production', maxAge: TOKEN_MAX_AGE });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    await logAudit(user.id, 'auth.login', 'user', String(user.id), null);
  } catch(e){ console.error('Error login:', e.message); res.status(500).json({ error:'Error interno' }); }
});

// Reset password (flujo simple dev) tablas y endpoints
async function ensurePasswordResets(){
  if(!pool) return;
  try { await pool.query(`CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
  );`);} catch(e){ console.warn('No tabla password_resets:', e.message); }
}

app.post('/api/auth/forgot', async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  const { username } = req.body || {};
  if(!username) return res.status(400).json({ error:'Falta username' });
  try {
    await ensurePasswordResets();
    const { rows } = await pool.query('SELECT id FROM users WHERE username=$1',[username]);
    if(!rows.length) return res.json({ ok:true, message:'Si existe se envió token' });
    const userId = rows[0].id; const token = randomUUID(); const expires = new Date(Date.now()+15*60*1000);
    await pool.query('INSERT INTO password_resets (id,user_id,token,expires_at) VALUES ($1,$2,$3,$4)', [randomUUID(), userId, token, expires]);
    await logAudit(userId, 'user.password.forgot.request', 'user', String(userId), null);
    res.json({ ok:true, token, expiresAt: expires.toISOString() });
  } catch(e){ console.error('forgot:', e.message); res.status(500).json({ error:'Error interno' }); }
});

app.post('/api/auth/forgot/reset', async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  const { token, newPassword } = req.body || {};
  if(!token || !newPassword) return res.status(400).json({ error:'Faltan campos' });
  if(newPassword.length < 6) return res.status(400).json({ error:'Contraseña muy corta' });
  try {
    await ensurePasswordResets();
    const { rows } = await pool.query('SELECT pr.id, pr.user_id, pr.expires_at, pr.used_at, u.role, u.username FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE pr.token=$1',[token]);
    if(!rows.length) return res.status(400).json({ error:'Token inválido' });
    const rec = rows[0];
    if(rec.used_at) return res.status(400).json({ error:'Token usado' });
    if(new Date(rec.expires_at) < new Date()) return res.status(400).json({ error:'Token expirado' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[rec.user_id, hash]);
    await pool.query('UPDATE password_resets SET used_at=NOW() WHERE id=$1',[rec.id]);
    const jwtToken = signToken({ id: rec.user_id, username: rec.username, role: rec.role });
  res.cookie('token', jwtToken, { httpOnly:true, sameSite:'lax', secure: !!process.env.RENDER || process.env.NODE_ENV==='production', maxAge: TOKEN_MAX_AGE });
    await logAudit(rec.user_id, 'user.password.forgot.reset', 'user', String(rec.user_id), null);
    res.json({ ok:true });
  } catch(e){ console.error('forgot reset:', e.message); res.status(500).json({ error:'Error interno' }); }
});

app.post('/api/auth/logout', (req,res)=>{
  res.clearCookie('token');
  res.json({ ok:true });
});

app.get('/api/auth/me', authMiddleware, async (req,res)=>{
  if(pool){
    try {
      await ensureRoleColumn();
      const { rows } = await pool.query('SELECT role FROM users WHERE id=$1',[req.user.uid]);
      if(rows.length){ req.user.role = rows[0].role; }
    } catch(_){}
  }
  res.json({ user: req.user });
});

// ===== User Management (admin) =====
app.get('/api/users', authMiddleware, requireAdmin, async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  try {
    await ensureRoleColumn();
    const { rows } = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC');
    res.json(rows);
  } catch(e){
    res.status(500).json({ error:'Error interno' });
  }
});

app.post('/api/users', authMiddleware, requireAdmin, async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  const { username, password, role } = req.body;
  if(!username || !password) return res.status(400).json({ error:'Faltan campos' });
  if(role && !VALID_ROLES.includes(role)) return res.status(400).json({ error:'Rol inválido' });
  try {
    await ensureRoleColumn();
    const hash = await bcrypt.hash(password, 10);
    const assignedRole = role || 'viewer';
    const { rows } = await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id, username, role, created_at',[username, hash, assignedRole]);
    res.status(201).json(rows[0]);
    await logAudit(req.user.uid, 'user.create', 'user', String(rows[0].id), { username: rows[0].username, role: rows[0].role });
    broadcast('user.create', { id: rows[0].id, username: rows[0].username, role: rows[0].role });
  } catch(e){
    if(e.code === '23505') return res.status(409).json({ error:'Usuario ya existe' });
    res.status(500).json({ error:'Error interno' });
  }
});

app.patch('/api/users/:id', authMiddleware, requireAdmin, async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  const { id } = req.params;
  const { role } = req.body;
  if(role && !VALID_ROLES.includes(role)) return res.status(400).json({ error:'Rol inválido' });
  try {
    await ensureRoleColumn();
    if(role && role !== 'admin'){
      const admins = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role='admin'");
      if(admins.rows[0].c === 1){
        const check = await pool.query('SELECT role FROM users WHERE id=$1',[id]);
        if(check.rows.length && check.rows[0].role === 'admin'){
          return res.status(400).json({ error:'No se puede degradar el último admin' });
        }
      }
    }
    const { rows } = await pool.query('UPDATE users SET role = COALESCE($2, role) WHERE id=$1 RETURNING id, username, role, created_at',[id, role || null]);
    if(!rows.length) return res.status(404).json({ error:'No encontrado' });
    res.json(rows[0]);
    await logAudit(req.user.uid, 'user.role.update', 'user', String(rows[0].id), { role: rows[0].role });
    broadcast('user.update', { id: rows[0].id, role: rows[0].role });
  } catch(e){
    res.status(500).json({ error:'Error interno' });
  }
});

app.delete('/api/users/:id', authMiddleware, requireAdmin, async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  const { id } = req.params;
  try {
    await ensureRoleColumn();
    const target = await pool.query('SELECT role FROM users WHERE id=$1',[id]);
    if(!target.rowCount) return res.status(404).json({ error:'No encontrado' });
    if(target.rows[0].role === 'admin'){
      const admins = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role='admin'");
      if(admins.rows[0].c === 1){
        return res.status(400).json({ error:'No se puede borrar el último admin' });
      }
    }
    await pool.query('DELETE FROM users WHERE id=$1',[id]);
    res.json({ ok:true });
    await logAudit(req.user.uid, 'user.delete', 'user', id, null);
    broadcast('user.delete', { id });
  } catch(e){
    res.status(500).json({ error:'Error interno' });
  }
});

app.post('/api/auth/change-password', authMiddleware, async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  const { currentPassword, newPassword } = req.body;
  if(!currentPassword || !newPassword) return res.status(400).json({ error:'Faltan campos' });
  try {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1',[req.user.uid]);
    if(!rows.length) return res.status(404).json({ error:'No encontrado' });
    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if(!ok) return res.status(401).json({ error:'Contraseña actual incorrecta' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[req.user.uid, hash]);
    res.json({ ok:true });
    await logAudit(req.user.uid, 'user.password.change', 'user', String(req.user.uid), null);
  } catch(e){ res.status(500).json({ error:'Error interno' }); }
});

app.post('/api/auth/admin-reset-password', authMiddleware, requireAdmin, async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  const { userId, newPassword } = req.body;
  if(!userId || !newPassword) return res.status(400).json({ error:'Faltan campos' });
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    const { rowCount } = await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[userId, hash]);
    if(!rowCount) return res.status(404).json({ error:'No encontrado' });
    res.json({ ok:true });
    await logAudit(req.user.uid, 'user.password.reset', 'user', String(userId), null);
  } catch(e){ res.status(500).json({ error:'Error interno' }); }
});

// Crear lead/venta previa al WhatsApp
app.post('/api/sales', async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  const { items, total, phone } = req.body;
  if(!Array.isArray(items) || items.length===0) return res.status(400).json({ error:'Items requeridos' });
  try {
    // Validar stock y preparar descuentos
    // items: [{ id, qty, nombre, precio }]
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updatedProducts = [];
      for(const it of items){
        if(!it.id || !it.qty) continue;
        const { rows } = await client.query('SELECT stock FROM products WHERE id=$1 FOR UPDATE',[it.id]);
        if(!rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error:`Producto inexistente ${it.id}` }); }
        const currentStock = rows[0].stock;
        if(currentStock < it.qty){ await client.query('ROLLBACK'); return res.status(409).json({ error:`Stock insuficiente para ${it.id}` }); }
        const newStock = currentStock - it.qty;
        await client.query('UPDATE products SET stock=$2 WHERE id=$1',[it.id, newStock]);
        await client.query('INSERT INTO stock_movements (id, product_id, delta, previous_stock, new_stock, reason, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), it.id, -it.qty, currentStock, newStock, 'sale', null]);
        const prodRow = await client.query('SELECT id, nombre, "desc" as desc, precio, img, categoria, stock, min_stock FROM products WHERE id=$1',[it.id]);
        if(prodRow.rows.length) updatedProducts.push(mapDbRow(prodRow.rows[0]));
      }
      const id = randomUUID();
      const saleRows = await client.query('INSERT INTO sales (id, items, total, phone) VALUES ($1,$2,$3,$4) RETURNING id, created_at, status, total, phone', [id, JSON.stringify(items), Number(total)||0, phone||null]);
      await client.query('COMMIT');
      productCache={at:0,data:null,source:'none'}; // invalidar cache productos
      res.status(201).json(saleRows.rows[0]);
      broadcast('sale.new', { id: saleRows.rows[0].id, status: saleRows.rows[0].status, created_at: saleRows.rows[0].created_at, total: saleRows.rows[0].total, phone: saleRows.rows[0].phone });
      // Emitir eventos de productos afectados con datos completos
      for(const p of updatedProducts){ broadcast('product.upsert', p); }
    } catch(e){
      await client.query('ROLLBACK');
      console.error('Error transacción sale:', e.message);
      return res.status(500).json({ error:'Error interno' });
    } finally { client.release(); }
  } catch(e){
    console.error('Error create sale:', e.message);
    res.status(500).json({ error:'Error interno' });
  }
});

// Listar ventas (auth)
app.get('/api/sales', authMiddleware, async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  try {
  let { page=1, pageSize=50, status, from, to, since } = req.query;
    page = Math.max(1, parseInt(page));
    pageSize = Math.min(200, Math.max(1, parseInt(pageSize)));
    const where = [];
    const params = [];
    let idx = 1;
    if(status){
      where.push(`status = $${idx++}`);
      params.push(status);
    }
    if(from){
      where.push(`created_at >= $${idx++}`);
      params.push(new Date(from));
    }
    if(to){
      // incluir todo el día final sumando 1 día y usando < siguiente día
      const end = new Date(to);
      end.setDate(end.getDate()+1);
      where.push(`created_at < $${idx++}`);
      params.push(end);
    }
    if(since){
      const sinceDate = new Date(since);
      if(!isNaN(sinceDate.getTime())){
        where.push(`created_at > $${idx++}`);
        params.push(sinceDate);
      }
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countSql = `SELECT COUNT(*)::int AS c FROM sales ${whereSql}`;
    const { rows: countRows } = await pool.query(countSql, params);
    const total = countRows[0].c;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if(page > totalPages) page = totalPages;
    const offset = (page - 1) * pageSize;
    const dataSql = `SELECT id, created_at, total, status, phone, notes FROM sales ${whereSql} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    const rows = (await pool.query(dataSql, [...params, pageSize, offset])).rows;
    res.json({ items: rows, page, pageSize, total, totalPages });
  } catch(e){
    console.error('Error list sales:', e.message);
    res.status(500).json({ error:'Error interno' });
  }
});

// Actualizar estado / notas de una venta
app.patch('/api/sales/:id', authMiddleware, async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  if(!canEditSales(req)) return res.status(403).json({ error:'Requiere rol editor o admin' });
  const { id } = req.params;
  const { status, notes } = req.body;
  const valid = ['pendiente','ganada','perdida'];
  if(status && !valid.includes(status)) return res.status(400).json({ error:'Estado inválido' });
  try {
    const { rows } = await pool.query('UPDATE sales SET status = COALESCE($2,status), notes = COALESCE($3,notes) WHERE id=$1 RETURNING id, status, notes', [id, status || null, notes || null]);
    if(!rows.length) return res.status(404).json({ error:'No encontrado' });
    res.json(rows[0]);
    await logAudit(req.user.uid, 'sale.update', 'sale', id, { status, notes });
    broadcast('sale.update', { id, status: rows[0].status });
  } catch(e){
    console.error('Error update sale:', e.message);
    res.status(500).json({ error:'Error interno' });
  }
});

// Obtener items de una venta
app.get('/api/sales/:id', authMiddleware, async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT id, created_at, items, total, status, phone, notes FROM sales WHERE id=$1', [id]);
    if(!rows.length) return res.status(404).json({ error:'No encontrado' });
    res.json(rows[0]);
  } catch(e){
    console.error('Error get sale:', e.message);
    res.status(500).json({ error:'Error interno' });
  }
});

// Auditoría (admin) con paginación y filtros
app.get('/api/audits', authMiddleware, requireAdmin, async (req,res)=>{
  if(!pool) return res.status(500).json({ error:'DB no disponible' });
  try {
    let { page=1, pageSize=50, action, userId } = req.query;
    page = Math.max(1, parseInt(page));
    pageSize = Math.min(200, Math.max(1, parseInt(pageSize)));
    const where = [];
    const params = [];
    let idx = 1;
    if(action){ where.push(`action = $${idx++}`); params.push(action); }
    if(userId){ where.push(`user_id = $${idx++}`); params.push(userId); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countSql = `SELECT COUNT(*)::int AS c FROM audits ${whereSql}`;
    const { rows: countRows } = await pool.query(countSql, params);
    const total = countRows[0].c;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if(page > totalPages) page = totalPages;
    const offset = (page - 1) * pageSize;
    const dataSql = `SELECT a.id, a.created_at, a.action, a.target_type, a.target_id, a.details, u.username AS user, a.user_id FROM audits a LEFT JOIN users u ON u.id = a.user_id ${whereSql} ORDER BY a.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    const rows = (await pool.query(dataSql, [...params, pageSize, offset])).rows;
    res.json({ items: rows, page, pageSize, total, totalPages });
  } catch(e){
    console.error('Error list audits:', e.message);
    res.status(500).json({ error:'Error interno' });
  }
});

