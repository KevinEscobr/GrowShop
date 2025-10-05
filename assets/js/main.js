// main.js

document.addEventListener('DOMContentLoaded', () => {
    loadProducts();
    setupCart();
});

function loadProducts() {
    fetch('../data/products.json')
        .then(response => response.json())
        .then(products => {
            const productContainer = document.getElementById('product-list');
            products.forEach(product => {
                const productCard = createProductCard(product);
                productContainer.appendChild(productCard);
            });
        })
        .catch(error => console.error('Error loading products:', error));
}

function createProductCard(product) {
    const card = document.createElement('div');
    card.className = 'col-md-4 mb-4';
    card.innerHTML = `
        <div class="card">
            <img src="${product.image}" class="card-img-top" alt="${product.name}">
            <div class="card-body">
                <h5 class="card-title">${product.name}</h5>
                <p class="card-text">${product.description}</p>
                <p class="card-price">$${product.price}</p>
                <button class="btn btn-primary add-to-cart" data-id="${product.id}">Add to Cart</button>
            </div>
        </div>
    `;
    card.querySelector('.add-to-cart').addEventListener('click', () => {
        addToCart(product.id);
    });
    return card;
}

function setupCart() {
    const cartButton = document.getElementById('cart-button');
    cartButton.addEventListener('click', () => {
        window.location.href = 'shop.html';
    });
}

function addToCart(productId) {
    // Logic to add product to cart
    console.log(`Product ${productId} added to cart`);
}

// Animaciones on-scroll simples
const observer = new IntersectionObserver((entries)=>{
  entries.forEach(e=>{
    if(e.isIntersecting){
      e.target.classList.add('visible');
      observer.unobserve(e.target);
    }
  });
},{threshold:.25});

document.querySelectorAll('.reveal').forEach(el=>observer.observe(el));

// Scroll suave para enlaces internos
document.addEventListener('click', e=>{
  const link = e.target.closest('.scroll-link');
  if(link){
    e.preventDefault();
    const id = link.getAttribute('href');
    const target = document.querySelector(id);
    if(target){
      window.scrollTo({top: target.offsetTop - 70, behavior:'smooth'});
    }
  }
});

// Navbar estilo dinámico (si existe)
document.addEventListener('scroll', ()=>{
  const nav = document.querySelector('.gs-navbar');
  if(!nav) return;
  if(window.scrollY > 40){
    nav.classList.add('scrolled');
  } else {
    nav.classList.remove('scrolled');
  }
});