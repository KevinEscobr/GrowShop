document.addEventListener("DOMContentLoaded", function() {
    const form = document.getElementById("contactForm");
    if (!form) return;

    const nameInput = document.getElementById("name");
    const emailInput = document.getElementById("email");
    const messageInput = document.getElementById("message");
    const errorMessage = document.getElementById("errorMessage");

    // Función para manejar el envío
    function handleValidationAndSubmit(event) {
        let valid = true;
        let messages = [];

        // Limpiar errores previos
        if (errorMessage) {
            errorMessage.classList.add("d-none");
            errorMessage.innerHTML = "";
        }

        // Validar nombre
        if (!nameInput || nameInput.value.trim() === "") {
            valid = false;
            messages.push("El nombre es obligatorio.");
        }

        // Validar email
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailInput || !emailPattern.test(emailInput.value.trim())) {
            valid = false;
            messages.push("Por favor, ingresa un correo electrónico válido.");
        }

        // Validar mensaje
        if (!messageInput || messageInput.value.trim() === "") {
            valid = false;
            messages.push("El mensaje no puede estar vacío.");
        }

        if (!valid) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            form.classList.add("was-validated");

            if (errorMessage) {
                // Generar los errores como items de lista para que no se vean amontonados
                errorMessage.innerHTML = messages.map(m => `<div><i class="bi bi-exclamation-triangle-fill me-2"></i>${m}</div>`).join('');
                errorMessage.classList.remove("d-none");
            }
            return false;
        } else {
            if (errorMessage) {
                errorMessage.classList.add("d-none");
            }
            // Si el formulario es totalmente válido, llamamos a la función de WhatsApp
            if (typeof sendWhatsAppMessage === "function") {
                if (event) event.preventDefault(); // Prevenir recarga del formulario HTML
                sendWhatsAppMessage();
            }
            return true;
        }
    }

    // Escuchar el evento submit del formulario
    form.addEventListener("submit", handleValidationAndSubmit);

    // Escuchar el clic del botón de WhatsApp alternativo
    const whatsappButton = document.getElementById("whatsapp-button");
    if (whatsappButton) {
        whatsappButton.addEventListener("click", function(e) {
            e.preventDefault();
            handleValidationAndSubmit(e);
        });
    }
});