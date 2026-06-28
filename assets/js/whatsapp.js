// Este archivo contiene la funcionalidad para enviar mensajes personalizados a través de WhatsApp.

function sendWhatsAppMessage() {
    const phoneNumber = "56971307840"; // Reemplaza con el número de teléfono deseado
    // Obtener datos del formulario
    const name = document.getElementById("name")?.value || "";
    const email = document.getElementById("email")?.value || "";
    const messageText = document.getElementById("message")?.value || "";
    let message;
    if (name || email || messageText) {
        message = `Hola, soy ${name} (${email}). Mi mensaje: ${messageText}`;
    } else {
        message = "¡Hola! Estoy interesado en tus productos.";
    }
    const url = `https://wa.me/${phoneNumber}?text=${encodeURIComponent(message)}`;
    window.open(url, "_blank");
}

// La activación del evento ahora es controlada centralizadamente en validation.js para asegurar la validación previa.