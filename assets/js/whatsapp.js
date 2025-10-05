// Este archivo contiene la funcionalidad para enviar mensajes personalizados a través de WhatsApp.

function sendWhatsAppMessage() {
    const phoneNumber = "123456789"; // Reemplaza con el número de teléfono deseado
    const message = encodeURIComponent("¡Hola! Estoy interesado en tus productos."); // Mensaje personalizado
    const url = `https://wa.me/${phoneNumber}?text=${message}`;

    window.open(url, "_blank");
}

// Evento para enviar el mensaje al hacer clic en un botón
document.addEventListener("DOMContentLoaded", function() {
    const whatsappButton = document.getElementById("whatsapp-button");
    if (whatsappButton) {
        whatsappButton.addEventListener("click", sendWhatsAppMessage);
    }
});