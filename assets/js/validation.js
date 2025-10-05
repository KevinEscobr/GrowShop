document.addEventListener("DOMContentLoaded", function() {
    const form = document.getElementById("contactForm");
    const nameInput = document.getElementById("name");
    const emailInput = document.getElementById("email");
    const messageInput = document.getElementById("message");
    const errorMessage = document.getElementById("errorMessage");

    form.addEventListener("submit", function(event) {
        let valid = true;
        errorMessage.textContent = "";

        // Validar nombre
        if (nameInput.value.trim() === "") {
            valid = false;
            errorMessage.textContent += "El nombre es obligatorio.\n";
        }

        // Validar email
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailPattern.test(emailInput.value.trim())) {
            valid = false;
            errorMessage.textContent += "Por favor, ingrese un correo electrónico válido.\n";
        }

        // Validar mensaje
        if (messageInput.value.trim() === "") {
            valid = false;
            errorMessage.textContent += "El mensaje no puede estar vacío.\n";
        }

        if (!valid) {
            event.preventDefault();
            errorMessage.style.display = "block";
        } else {
            errorMessage.style.display = "none";
        }
    });
});