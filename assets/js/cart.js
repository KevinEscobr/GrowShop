// assets/js/cart.js

const state = {
  products: [],
  filtered: [],
  cart: JSON.parse(localStorage.getItem('grow_cart') || '[]'),
  taxRate: 0.19
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheEls();
  loadProducts();
  bindUI();
  renderCart();
});

function cacheEls(){
  els.grid = document.getElementById('productsGrid');
  els.search = document.getElementById('searchInput');
  els.category = document.getElementById('categoryFilter');
  els.sort = document.getElementById('sortSelect');
  els.cartItems = document.getElementById('cartItems');
  els.subtotal = document.getElementById('cartSubtotal');
  els.tax = document.getElementById('cartTax');
  els.total = document.getElementById('cartTotal');
  els.cartCountBadge = document.getElementById('cartCountBadge');
  els.whatsappBtn = document.getElementById('whatsappBtn');
  els.checkoutBtn = document.getElementById('checkoutBtn');
  els.clearCartBtn = document.getElementById('clearCartBtn');
}

async function loadProducts(){
  try {
    const res = await fetch('data/products.json');
    state.products = await res.json();
    buildCategoryFilter();
    state.filtered = [...state.products];
    renderProducts();
  } catch (e){
    els.grid.innerHTML = `<div class="col-12 text-danger small">Error cargando productos</div>`;
    console.error(e);
  }
}

function buildCategoryFilter(){
  const cats = [...new Set(state.products.map(p=>p.categoria))];
  cats.forEach(c=>{
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = capitalize(c);
    els.category.appendChild(opt);
  });
}

function bindUI(){
  els.search.addEventListener('input', applyFilters);
  els.category.addEventListener('change', applyFilters);
  els.sort.addEventListener('change', applyFilters);
  els.whatsappBtn.addEventListener('click', sendWhatsApp);
  els.checkoutBtn.addEventListener('click', openPaymentModal);
  els.clearCartBtn.addEventListener('click', clearCart);
}

function applyFilters(){
  const q = els.search.value.toLowerCase();
  const cat = els.category.value;
  state.filtered = state.products.filter(p=>{
    const matchQ = p.nombre.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q);
    const matchC = cat === 'all' || p.categoria === cat;
    return matchQ && matchC;
  });
  sortProducts();
  renderProducts();
}

function sortProducts(){
  switch(els.sort.value){
    case 'priceAsc': state.filtered.sort((a,b)=>a.precio-b.precio); break;
    case 'priceDesc': state.filtered.sort((a,b)=>b.precio-a.precio); break;
    case 'nameAsc': state.filtered.sort((a,b)=>a.nombre.localeCompare(b.nombre)); break;
    default: break;
  }
}

function renderProducts(){
  els.grid.innerHTML = state.filtered.map(p=>`
    <div class="col-12 col-sm-6 col-lg-4 col-xl-3">
      <div class="product-card glass h-100 d-flex flex-column">
        <div class="ratio ratio-4x3 mb-2 product-thumb">
          <img src="${p.img}" alt="${p.nombre}" class="w-100 h-100 object-fit-cover">
        </div>
        <div class="d-flex flex-column flex-grow-1">
          <h6 class="mb-1 fw-semibold">${p.nombre}</h6>
          <p class="text-secondary small flex-grow-1 mb-2">${p.desc}</p>
          <div class="d-flex justify-content-between align-items-center">
            <span class="fw-semibold text-success">$${p.precio.toFixed(2)}</span>
            <button class="btn btn-gradient btn-sm" data-add="${p.id}">Agregar</button>
          </div>
        </div>
      </div>
    </div>
  `).join('');

  els.grid.querySelectorAll('[data-add]').forEach(btn=>{
    btn.addEventListener('click', ()=> addToCart(btn.dataset.add));
  });
}

function addToCart(id){
  const prod = state.products.find(p=>p.id===id);
  if(!prod) return;
  const item = state.cart.find(i=>i.id===id);
  if(item){
    item.qty++;
  } else {
    state.cart.push({ id: prod.id, nombre: prod.nombre, precio: prod.precio, qty:1 });
  }
  persistCart();
  renderCart();
  animateBadge();
}

function renderCart(){
  if(!els.cartItems) return;
  if(state.cart.length === 0){
    els.cartItems.innerHTML = `<div class="p-3 text-center small text-secondary">Carrito vacío</div>`;
  } else {
    els.cartItems.innerHTML = state.cart.map(i=>`
      <div class="cart-line d-flex align-items-center gap-2 px-3 py-2 border-bottom border-opacity-10">
        <div class="flex-grow-1">
          <div class="small fw-semibold">${i.nombre}</div>
          <div class="text-secondary tiny">$${i.precio.toFixed(2)}</div>
        </div>
        <div class="d-flex align-items-center gap-1 qty-group">
          <button class="btn btn-outline-light btn-sm px-2" data-dec="${i.id}">-</button>
          <span class="small">${i.qty}</span>
          <button class="btn btn-outline-light btn-sm px-2" data-inc="${i.id}">+</button>
        </div>
        <div class="small fw-semibold" style="width:70px;text-align:right;">$${(i.precio*i.qty).toFixed(2)}</div>
        <button class="btn btn-outline-danger btn-sm ms-1" data-del="${i.id}">&times;</button>
      </div>
    `).join('');
  }

  els.cartItems.querySelectorAll('[data-inc]').forEach(b=>b.addEventListener('click',()=> changeQty(b.dataset.inc,1)));
  els.cartItems.querySelectorAll('[data-dec]').forEach(b=>b.addEventListener('click',()=> changeQty(b.dataset.dec,-1)));
  els.cartItems.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',()=> removeItem(b.dataset.del)));

  updateTotals();
  updateBadge();
}

function changeQty(id, delta){
  const item = state.cart.find(i=>i.id===id);
  if(!item) return;
  item.qty += delta;
  if(item.qty <= 0){
    state.cart = state.cart.filter(i=>i.id!==id);
  }
  persistCart();
  renderCart();
}

function removeItem(id){
  state.cart = state.cart.filter(i=>i.id!==id);
  persistCart();
  renderCart();
}

function clearCart(){
  if(!confirm('¿Vaciar carrito?')) return;
  state.cart = [];
  persistCart();
  renderCart();
}

function updateTotals(){
  const subtotal = state.cart.reduce((acc,i)=>acc + i.precio*i.qty,0);
  const tax = subtotal * state.taxRate;
  const total = subtotal + tax;
  els.subtotal.textContent = money(subtotal);
  els.tax.textContent = money(tax);
  els.total.textContent = money(total);
}

function updateBadge(){
  const count = state.cart.reduce((a,i)=>a+i.qty,0);
  if(count>0){
    els.cartCountBadge.classList.remove('d-none');
    els.cartCountBadge.textContent = count;
  } else {
    els.cartCountBadge.classList.add('d-none');
  }
}

function money(n){ return '$' + n.toFixed(2); }

function persistCart(){
  localStorage.setItem('grow_cart', JSON.stringify(state.cart));
}

function sendWhatsApp(){
  if(state.cart.length===0) return;
  const lines = state.cart.map(i=>`• ${i.nombre} x${i.qty} = $${(i.precio*i.qty).toFixed(2)}`).join('%0A');
  const total = els.total.textContent;
  const msg = `Hola, quisiera confirmar este pedido:%0A${lines}%0A${'-'.repeat(8)}%0ATotal: ${total}`;
  const phone = '34600000000'; // Cambiar
  window.open(`https://wa.me/${phone}?text=${msg}`,'_blank');
}

function openPaymentModal(){
  if(state.cart.length===0) return;
  const ul = document.getElementById('paymentSummary');
  ul.innerHTML = state.cart.map(i=>`<li class="d-flex justify-content-between"><span class="small">${i.nombre} x${i.qty}</span><span class="small">$${(i.precio*i.qty).toFixed(2)}</span></li>`).join('');
  document.getElementById('paymentTotal').textContent = els.total.textContent;
  const modal = new bootstrap.Modal('#paymentModal');
  modal.show();
}

function animateBadge(){
  if(!els.cartCountBadge) return;
  els.cartCountBadge.animate([
    { transform:'scale(1)' },
    { transform:'scale(1.4)' },
    { transform:'scale(1)' }
  ],{duration:400,easing:'ease'});
}

function capitalize(s){ return s.charAt(0).toUpperCase()+s.slice(1); }