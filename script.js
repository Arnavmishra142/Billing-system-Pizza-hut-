// Dummy Data
const categories = ['Burger', 'Cakes', 'Chinese', 'Pizza', 'Pav Bhaji', 'Beverages', 'Momos', 'Rolls'];

const items = [
    { code: '149', name: 'Veg Burger', price: 99 },
    { code: '150', name: 'Mexican Burger', price: 129 },
    { code: '151', name: 'Cheese Burger', price: 149 },
    { code: '236', name: 'Black Forest Cake', price: 300 },
    { code: '237', name: 'White Forest Cake', price: 350 },
    { code: '238', name: 'Choco Chips', price: 400 },
];

const cart = [
    { name: 'Veg Burger', price: 99, qty: 2 }
];

// Initialize UI
document.addEventListener('DOMContentLoaded', () => {
    loadCategories();
    loadItems();
    loadCart();
});

// Load Categories into Sidebar
function loadCategories() {
    const list = document.getElementById('categoryList');
    categories.forEach(cat => {
        let li = document.createElement('li');
        li.innerText = cat;
        li.onclick = () => console.log(`Category clicked: ${cat}`);
        list.appendChild(li);
    });
}

// Load Items into Grid
function loadItems() {
    const grid = document.getElementById('itemsGrid');
    items.forEach(item => {
        let card = document.createElement('div');
        card.className = 'item-card';
        card.innerHTML = `
            <div class="item-image"></div>
            <div class="item-title">${item.code} | ${item.name}</div>
            <div class="item-price">₹${item.price}</div>
        `;
        // Adding item click logic later
        card.onclick = () => alert(`${item.name} added to cart!`);
        grid.appendChild(card);
    });
}

// Load Cart Data
function loadCart() {
    const cartContainer = document.getElementById('cartItems');
    cart.forEach(item => {
        let cartItem = document.createElement('div');
        cartItem.className = 'cart-item';
        cartItem.innerHTML = `
            <div class="cart-item-header">
                <span>${item.name}</span>
                <span>₹${item.price * item.qty}</span>
            </div>
            <div class="cart-item-controls">
                <span style="color: #6b7280; font-size: 0.8rem;">₹${item.price} x ${item.qty}</span>
                <div class="quantity-control">
                    <button class="qty-btn qty-minus">-</button>
                    <span>${item.qty}</span>
                    <button class="qty-btn qty-plus">+</button>
                </div>
            </div>
        `;
        cartContainer.appendChild(cartItem);
    });
}
