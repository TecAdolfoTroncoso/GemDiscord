//------------------------------------------------Librerias------------------------------------------------//
require("dotenv").config();
const fetch = require("node-fetch");
const {
    Client,
    GatewayIntentBits,
    Partials,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    TextInputBuilder,
    TextInputStyle,
    ModalBuilder,
    ModalSubmitInteraction,
} = require("discord.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { HarmBlockThreshold, HarmCategory } = require("@google/generative-ai");
const { writeFile, unlink } = require("fs/promises");
const { createWriteStream, mkdtempSync, promises: fsPromises } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const util = require("util");
const streamPipeline = util.promisify(require("stream").pipeline);
const fs = require("fs").promises;
const sharp = require("sharp");
const pdf = require("pdf-parse");
const cheerio = require("cheerio");
const { YoutubeTranscript } = require("youtube-transcript");

//------------------------------------------------IA Configuracion------------------------------------------------//
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
});
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const chatHistories = {};
const activeUsersInChannels = {};
const customInstructions = {};
const userPreferredImageModel = {};
const activeRequests = new Set();

//------------------------------------------------Discord Codigo------------------------------------------------//
client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}!`);
});
// Escucha los eventos de creación de mensajes en Discord
client.on("messageCreate", async (message) => {
    try {
        // Evita que el bot responda a sus propios mensajes
        if (message.author.bot) return;

        // Determina si el bot está activo para el canal, mencionado o en un DM
        const isDM = message.channel.type === ChannelType.DM;
        const isBotMentioned = message.mentions.users.has(client.user.id);
        const isUserActiveInChannel =
            (activeUsersInChannels[message.channelId] &&
                activeUsersInChannels[message.channelId][message.author.id]) ||
            isDM;

        // Si el usuario está activo en el canal o el bot está mencionado, procesa el mensaje
        if (isUserActiveInChannel || (isBotMentioned && !isDM)) {
            // Comprueba si hay una solicitud activa para el usuario
            if (activeRequests.has(message.author.id)) {
                // Si hay una solicitud activa, responde al usuario que espere
                await message.reply(
                    "> `Please wait until your previous action is complete.`"
                );
                return;
            } else if (message.attachments.size > 0 && hasImageAttachments(message)) {
                // Si hay archivos adjuntos de imagen, procesa el mensaje de imagen
                await handleImageMessage(message);
            } else if (
                message.attachments.size > 0 &&
                hasTextFileAttachments(message)
            ) {
                // Si hay archivos adjuntos de archivos de texto, procesa el mensaje de archivo de texto
                await handleTextFileMessage(message);
            } else {
                // Si no hay archivos adjuntos, procesa el mensaje de texto
                await handleTextMessage(message);
            }
        }
    } catch (error) {
        // Si se produce un error, muestra un mensaje de error en la consola y responde al usuario
        console.error("Error handling a message:", error);
        message.reply("Sorry, something went wrong!");
    }
});

// Función para alternar la respuesta del bot a los mensajes del usuario
async function alwaysRespond(interaction) {
    // Obtener el ID del usuario y el ID del canal de la interacción
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    // Asegurarse de que el canal está inicializado en activeUsersInChannels
    if (!activeUsersInChannels[channelId]) {
        activeUsersInChannels[channelId] = {};
    }

    // Alternar el estado para el canal y el usuario actuales
    if (activeUsersInChannels[channelId][userId]) {
        // Si el usuario está activo, desactivarlo
        delete activeUsersInChannels[channelId][userId];

        // Enviar un mensaje efímero al usuario que interactuó
        await interaction.reply({
            content: "> Bot response to your messages is turned `OFF`.",
            ephemeral: true,
        });
    } else {
        // Si el usuario no está activo, activarlo
        activeUsersInChannels[channelId][userId] = true;

        // Enviar un mensaje efímero al usuario que interactuó
        await interaction.reply({
            content: "> Bot response to your messages is turned `ON`.",
            ephemeral: true,
        });
    }
}

// Función para borrar el historial de chat de un usuario específico.
async function clearChatHistory(interaction) {
    // Borra el historial de chat del usuario.
    chatHistories[interaction.user.id] = [];

    // Envía un mensaje efímero al usuario que interactuó.
    await interaction.reply({
        content: "> `¡Historial de chat borrado!`", // El mensaje que se enviará al usuario.
        ephemeral: true, // Establece el mensaje como efímero para que desaparezca después de un tiempo.
    });
}

// Escucha las interacciones de los usuarios.

client.on("interactionCreate", async (interaction) => {
    // Comprueba si la interacción es un clic en un botón.
    if (interaction.isButton()) {
        // Maneja la interacción en función del ID personalizado del botón que se hizo clic.
        switch (interaction.customId) {
            case "settings":
                await showSettings(interaction);
                break;
            case "clear":
                await clearChatHistory(interaction);
                break;
            case "always-respond":
                await alwaysRespond(interaction);
                break;
            case "custom-personality":
                await setCustomPersonality(interaction);
                break;
            case "remove-personality":
                await removeCustomPersonality(interaction);
                break;
            default:
                // Si el ID personalizado del botón no coincide con ninguna de las opciones anteriores, ignóralo.
                break;
        }
    } else if (interaction.isModalSubmit()) {
        // Si la interacción es el envío de un modal, maneja el envío del modal.
        await handleModalSubmit(interaction);
    }
});

// Función para manejar el envío de un modal
async function handleModalSubmit(interaction) {
    // Comprobar el ID personalizado del modal
    if (interaction.customId === "custom-personality-modal") {
        // Obtener el valor del campo de texto "custom-personality-input"
        const customInstructionsInput = interaction.fields.getTextInputValue(
            "custom-personality-input"
        );

        // Guardar las instrucciones personalizadas para el usuario
        customInstructions[interaction.user.id] = customInstructionsInput.trim();

        // Responder al usuario con un mensaje de confirmación
        await interaction.reply({
            content: "> Custom personality instructions saved!",
        });

        // Eliminar la respuesta después de 10 segundos
        setTimeout(() => interaction.deleteReply(), 10000);
    }
}

// Función para establecer una personalidad personalizada para el bot
async function setCustomPersonality(interaction) {
    // ID personalizado del campo de texto
    const customId = "custom-personality-input";

    // Título del modal
    const title = "Enter Custom Personality Instructions";

    // Crear un nuevo campo de texto
    const input = new TextInputBuilder()
        // Establecer el ID personalizado del campo de texto
        .setCustomId(customId)
        // Establecer la etiqueta del campo de texto
        .setLabel("What should the bot's personality be like?")
        // Establecer el estilo del campo de texto
        .setStyle(TextInputStyle.Paragraph)
        // Establecer el placeholder del campo de texto
        .setPlaceholder("Enter the custom instructions here...")
        // Establecer la longitud mínima del campo de texto
        .setMinLength(10)
        // Establecer la longitud máxima del campo de texto
        .setMaxLength(4000);

    // Crear un nuevo modal
    const modal = new ModalBuilder()
        // Establecer el ID personalizado del modal
        .setCustomId("custom-personality-modal")
        // Establecer el título del modal
        .setTitle(title)
        // Añadir componentes al modal
        .addComponents(
            // Crear una nueva fila de acciones
            new ActionRowBuilder()
                // Añadir componentes a la fila de acciones
                .addComponents(
                    // Añadir el campo de texto a la fila de acciones
                    input
                )
        );

    // Mostrar el modal al usuario
    await interaction.showModal(modal);
}

// Función para mostrar los ajustes del bot
async function showSettings(interaction) {
    // Crear un botón para borrar el chat
    const clearButton = new ButtonBuilder()
        // Establecer el ID personalizado del botón
        .setCustomId("clear")
        // Establecer la etiqueta del botón
        .setLabel("Clear Chat")
        // Establecer el estilo del botón
        .setStyle(ButtonStyle.Danger);

    // Crear un botón para alternar la respuesta del bot
    const toggleChatButton = new ButtonBuilder()
        // Establecer el ID personalizado del botón
        .setCustomId("always-respond")
        // Establecer la etiqueta del botón
        .setLabel("Always Respond")
        // Establecer el estilo del botón
        .setStyle(ButtonStyle.Secondary);

    // Crear un botón para establecer una personalidad personalizada
    const customPersonalityButton = new ButtonBuilder()
        // Establecer el ID personalizado del botón
        .setCustomId("custom-personality")
        // Establecer la etiqueta del botón
        .setLabel("Custom Personality")
        // Establecer el estilo del botón
        .setStyle(ButtonStyle.Primary);

    // Crear un botón para eliminar la personalidad personalizada
    const removePersonalityButton = new ButtonBuilder()
        // Establecer el ID personalizado del botón
        .setCustomId("remove-personality")
        // Establecer la etiqueta del botón
        .setLabel("Remove Personality")
        // Establecer el estilo del botón
        .setStyle(ButtonStyle.Danger);

    // Dividir los ajustes en varias filas de acciones si hay más de 5 botones
    const actionRows = [];
    const allButtons = [
        clearButton,
        toggleChatButton,
        customPersonalityButton,
        removePersonalityButton,
    ];

    // Añadir los botones a las filas de acciones
    while (allButtons.length > 0) {
        const actionRow = new ActionRowBuilder().addComponents(
            allButtons.splice(0, 5)
        );
        actionRows.push(actionRow);
    }
    // Enviar los ajustes al usuario
    await interaction.reply({
        // Establecer el contenido del mensaje
        content: "> ```Settings:```",
        // Añadir los componentes (filas de acciones) al mensaje
        components: actionRows,
        // Hacer que el mensaje sea efímero (visible solo para el usuario que lo envió)
        ephemeral: true,
    });
}

// Función para manejar los mensajes que contienen imágenes
async function handleImageMessage(message) {
    // Filtrar los archivos adjuntos de imagen del mensaje
    const imageAttachments = message.attachments.filter((attachment) =>
        attachment.contentType?.startsWith("image/")
    );

    // Eliminar las menciones al bot del contenido del mensaje
    let messageContent = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`), "")
        .trim();

    // Si hay archivos adjuntos de imagen
    if (imageAttachments.size > 0) {
        // Obtener el modelo de visión de Generative AI
        const visionModel = await genAI.getGenerativeModel({
            model: "gemini-pro-vision",
        });

        // Procesar cada uno de los archivos adjuntos de imagen
        const imageParts = await Promise.all(
            imageAttachments.map(async (attachment) => {
                // Obtener el buffer de la imagen
                const response = await fetch(attachment.url);
                const buffer = await response.buffer();

                // Comprobar si el tamaño de la imagen es demasiado grande
                if (buffer.length > 4 * 1024 * 1024) {
                    try {
                        // Intentar comprimir la imagen
                        const compressedBuffer = await compressImage(buffer);

                        // Comprobar si la imagen comprimida sigue siendo demasiado grande
                        if (compressedBuffer.length > 4 * 1024 * 1024) {
                            // Si la imagen comprimida sigue siendo demasiado grande, lanzar un error
                            throw new Error("Image too large after compression.");
                        }

                        // Devolver la imagen comprimida
                        return {
                            inlineData: {
                                data: compressedBuffer.toString("base64"),
                                mimeType: "image/jpeg",
                            },
                        };
                    } catch (error) {
                        // Si se produce un error al comprimir la imagen, mostrar un mensaje de error al usuario
                        console.error("Compression error:", error);
                        await message.reply(
                            "The image is too large for Gemini to process even after attempting to compress it."
                        );

                        // Relanzar el error
                        throw error;
                    }
                } else {
                    // Devolver la imagen sin comprimir
                    return {
                        inlineData: {
                            data: buffer.toString("base64"),
                            mimeType: attachment.contentType,
                        },
                    };
                }
            })
        );
        // Enviar un mensaje al usuario indicando que se está analizando la imagen
        const botMessage = await message.reply({
            content: "Analyzing the image(s) with your text prompt...",
        });

        // Manejar la respuesta del modelo
        await handleModelResponse(
            // Pasar el mensaje del bot como referencia
            botMessage,
            // Función asíncrona para generar el contenido con el modelo de visión
            async () =>
                visionModel.generateContentStream([messageContent, ...imageParts]),
            // Pasar el mensaje original como referencia
            message
        );
    }
}

// Función para comprimir y redimensionar una imagen
async function compressImage(buffer) {
    // Dimensión máxima de la imagen
    const maxDimension = 3072;

    // Utilizar la biblioteca `sharp` para procesar la imagen
    return sharp(buffer)
        // Redimensionar la imagen a la dimensión máxima especificada
        .resize(maxDimension, maxDimension, {
            // Ajustar la imagen dentro de la dimensión máxima
            fit: sharp.fit.inside,
            // No ampliar la imagen si es más pequeña que la dimensión máxima
            withoutEnlargement: true,
        })
        // Convertir la imagen a formato JPEG con una calidad del 80%
        .jpeg({ quality: 80 })
        // Devolver la imagen comprimida como un buffer
        .toBuffer();
}

// Función para manejar los mensajes que contienen archivos de texto
async function handleTextFileMessage(message) {
    // Eliminar las menciones al bot del contenido del mensaje
    let messageContent = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`), "")
        .trim();

    // Filtrar los archivos adjuntos de texto del mensaje
    const fileAttachments = message.attachments.filter(
        (attachment) =>
            attachment.contentType?.startsWith("application/pdf") ||
            attachment.contentType?.startsWith("text/plain") ||
            attachment.contentType?.startsWith("text/html") ||
            attachment.contentType?.startsWith("text/css") ||
            attachment.contentType?.startsWith("application/javascript") ||
            attachment.contentType?.startsWith("application/json")
    );

    // Si hay archivos adjuntos de texto
    if (fileAttachments.size > 0) {
        // Enviar un mensaje al usuario indicando que se está procesando el documento
        let botMessage = await message.reply({
            content: "Processing your document(s)...",
        });

        // Formatear el mensaje para incluir el contenido de los archivos adjuntos
        let formattedMessage = messageContent;

        // Extraer el texto de todos los archivos adjuntos
        for (const [attachmentId, attachment] of fileAttachments) {
            let extractedText;

            // Si el archivo adjunto es un PDF, extraer el texto
            if (attachment.contentType?.startsWith("application/pdf")) {
                extractedText = await extractTextFromPDF(attachment.url);
            }
            // Si el archivo adjunto es un archivo de texto, obtener el contenido del texto
            else {
                extractedText = await fetchTextContent(attachment.url);
            }

            // Añadir el contenido del archivo adjunto al mensaje formateado
            formattedMessage += `\n\n[${attachment.name}] File Content:\n"${extractedText}"`;
        }

        // Cargar el modelo de texto para manejar la conversación
        const model = await genAI.getGenerativeModel({ model: "gemini-pro" });

        // Iniciar un chat con el modelo
        const chat = model.startChat({
            // Pasar el historial de la conversación al modelo
            history: getHistory(message.author.id),
            // Pasar la configuración de seguridad al modelo
            safetySettings,
        });

        // Manejar la respuesta del modelo
        await handleModelResponse(
            // Pasar el mensaje del bot como referencia
            botMessage,
            // Función asíncrona para enviar el mensaje formateado al modelo
            () => chat.sendMessageStream(formattedMessage),
            // Pasar el mensaje original como referencia
            message
        );
    }
}

// Función para comprobar si el mensaje contiene archivos adjuntos de imagen
function hasImageAttachments(message) {
    // Comprobar si alguno de los archivos adjuntos del mensaje es una imagen
    return message.attachments.some((attachment) =>
        attachment.contentType?.startsWith("image/")
    );
}

// Función para comprobar si el mensaje contiene archivos adjuntos de texto
function hasTextFileAttachments(message) {
    // Comprobar si alguno de los archivos adjuntos del mensaje es un archivo de texto
    return message.attachments.some(
        (attachment) =>
            attachment.contentType?.startsWith("application/pdf") ||
            attachment.contentType?.startsWith("text/plain") ||
            attachment.contentType?.startsWith("text/html") ||
            attachment.contentType?.startsWith("text/css") ||
            attachment.contentType?.startsWith("application/javascript") ||
            attachment.contentType?.startsWith("application/json")
    );
}

// Función para obtener el contenido de texto de una URL
async function fetchTextContent(url) {
    try {
        // Obtener el contenido de texto de la URL mediante una petición HTTP
        const response = await fetch(url);
        return await response.text();
    } catch (error) {
        // Mostrar un mensaje de error si no se puede obtener el contenido de texto
        console.error("Error fetching text content:", error);
        throw new Error("Could not fetch text content from file");
    }
}

// Definir un array de configuraciones de seguridad con categorías y umbrales
const safetySettings = [
    {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT, // Categoría: Acoso
        threshold: HarmBlockThreshold.BLOCK_NONE, // Umbral: No bloquear nada
    },
    {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, // Categoría: Discurso de odio
        threshold: HarmBlockThreshold.BLOCK_NONE, // Umbral: No bloquear nada
    },
    {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, // Categoría: Sexualmente explícito
        threshold: HarmBlockThreshold.BLOCK_NONE, // Umbral: No bloquear nada
    },
    {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, // Categoría: Contenido peligroso
        threshold: HarmBlockThreshold.BLOCK_NONE, // Umbral: No bloquear nada
    },
];

// Función para extraer contenido de una página web
async function scrapeWebpageContent(url) {
    try {
        // Obtener el contenido de la página web usando la URL proporcionada
        const response = await fetch(url);
        // Parsear el HTML usando cheerio
        const html = await response.text();
        const $ = cheerio.load(html);

        // Eliminar etiquetas de script y estilo junto con su contenido
        $("script, style").remove();

        // Extraer y limpiar el contenido de texto dentro de la etiqueta <body>
        let bodyText = $("body").text();

        // Eliminar cualquier texto que aún pueda estar encerrado entre corchetes angulares
        bodyText = bodyText.replace(/<[^>]*>?/gm, "");

        // Recortar los espacios en blanco iniciales y finales y devolver el texto limpio
        return bodyText.trim();
    } catch (error) {
        // Manejar errores que puedan ocurrir durante el proceso de extracción
        console.error("Error al extraer el contenido de la página web:", error);
        throw new Error("No se pudo extraer el contenido de la página web");
    }
}

// Función para manejar mensajes de texto
async function handleTextMessage(message) {
    // Obtener el modelo generativo gemini-pro
    const model = await genAI.getGenerativeModel({ model: "gemini-pro" });

    // Variable para almacenar la respuesta del bot
    let botMessage;

    // Obtener el ID del usuario que envió el mensaje
    const userId = message.author.id;

    // Obtener el contenido del mensaje, eliminando cualquier mención al bot y recortando los espacios
    let messageContent = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`), "")
        .trim();

    // Comprobar si el mensaje está vacío
    if (messageContent === "") {
        // Responder al usuario indicando que no ha dicho nada
        await message.reply(
            "> It looks like you didn't say anything. What would you like to talk about?"
        );
        return;
    }

    // Obtener las instrucciones personalizadas para el usuario
    const instructions = customInstructions[message.author.id];

    // Formatear el mensaje incluyendo las instrucciones personalizadas, si existen
    let formattedMessage = instructions
        ? `[Instructions To Follow]: ${instructions}\n\n[User Message]: ${messageContent}`
        : messageContent;


    // Extraer las URL del mensaje
    const urls = extractUrls(messageContent);

    // Añadir el ID del usuario a la lista de solicitudes activas
    activeRequests.add(userId);

    // Variable para almacenar las transcripciones de los vídeos
    const videoTranscripts = {};

    // Comprobar si hay URL en el mensaje
    if (urls.length > 0) {
        // Responder al usuario indicando que se está obteniendo el contenido de las URL
        botMessage = await message.reply("Fetching content from the URLs...");

        // Manejar las URL en el mensaje
        await handleUrlsInMessage(urls, formattedMessage, botMessage, message);
    } else {
        // Responder al usuario indicando que el bot está pensando
        botMessage = await message.reply("> Let me think...");

        // Iniciar un chat con el modelo generativo
        const chat = model.startChat({
            history: getHistory(message.author.id), // Obtener el historial de la conversación
            safetySettings, // Aplicar las configuraciones de seguridad
        });

        // Manejar la respuesta del modelo
        await handleModelResponse(
            botMessage,
            () => chat.sendMessageStream(formattedMessage), // Enviar el mensaje formateado al modelo
            message
        );
    }
}

// Función para eliminar la personalidad personalizada de un usuario
async function removeCustomPersonality(interaction) {
    // Eliminar las instrucciones personalizadas para el usuario
    delete customInstructions[interaction.user.id];

    // Informar al usuario de que sus instrucciones personalizadas han sido eliminadas
    await interaction.reply({
        content: "> ¡Instrucciones de personalidad personalizadas eliminadas!",
        ephemeral: true, // Hacer que el mensaje sea efímero (desaparezca después de un tiempo)
    });
}

// Función para manejar las URL en un mensaje
async function handleUrlsInMessage(
    urls, // Array de URL extraídas del mensaje del usuario
    messageContent, // Contenido original del mensaje del usuario
    botMessage, // Mensaje de respuesta del bot indicando que está obteniendo el contenido de las URL
    originalMessage // Mensaje original del usuario
) {
    // Obtener el modelo generativo gemini-pro
    const model = await genAI.getGenerativeModel({ model: "gemini-pro" });

    // Iniciar un chat con el modelo generativo
    const chat = model.startChat({
        history: getHistory(originalMessage.author.id), // Obtener el historial de la conversación
        safetySettings, // Aplicar las configuraciones de seguridad
    });

    // Variable para llevar la cuenta del contenido
    let contentIndex = 1;

    // Variable para almacenar el contenido del mensaje con las URL procesadas
    let contentWithUrls = messageContent;

    // Recorrer las URL
    for (const url of urls) {
        try {
            // Comprobar si la URL es un vídeo de YouTube
            if (url.includes("youtu.be") || url.includes("youtube.com")) {
                // Extraer el ID del vídeo de YouTube
                const videoId = extractYouTubeVideoId(url);

                // Obtener la transcripción del vídeo
                const transcriptData = await YoutubeTranscript.fetchTranscript(videoId);

                // Convertir la transcripción en texto plano
                const transcriptText = transcriptData
                    .map((item) => item.text)
                    .join(" ");

                // Añadir la transcripción del vídeo al contenido del mensaje
                contentWithUrls += `\n\n[Transcript of Video ${contentIndex}]:\n"${transcriptText}"`;
            } else {
                // Para las URL que no son vídeos, intentar extraer el contenido de la página web
                const webpageContent = await scrapeWebpageContent(url);
                // Añadir el contenido de la página web al contenido del mensaje
                contentWithUrls += `\n\n[Content of URL ${contentIndex}]:\n"${webpageContent}"`;
            }

            // Reemplazar la URL con una referencia en el texto
            contentWithUrls = contentWithUrls.replace(
                url,
                `[Reference ${contentIndex}](${url})`
            );

            // Incrementar el contador de contenido
            contentIndex++;
        } catch (error) {
            // Manejar errores al obtener el contenido de la URL
            console.error("Error handling URL:", error);
            contentWithUrls += `\n\n[Error]: Can't access content from the [URL ${contentIndex}](${url}), likely due to bot blocking. Mention if you were blocked in your reply.`;
        }
    }

    // Una vez procesadas todas las URL, continuar con la respuesta del chat
    await handleModelResponse(
        botMessage,
        () => chat.sendMessageStream(contentWithUrls), // Enviar el contenido del mensaje con las URL procesadas al modelo
        originalMessage
    );
}

// Función para extraer el ID del vídeo de YouTube de una URL.

function extractYouTubeVideoId(url) {
    // Defina una expresión regular para que coincida con los ID de vídeo de YouTube.

    const regExp =
        /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;

    // Utilice la expresión regular para hacer coincidir la URL.

    const match = url.match(regExp);

    // Si la URL contiene un ID de vídeo de YouTube válido, devuélvelo.

    return match && match[2].length === 11 ? match[2] : null;
}

// Función para extraer todas las URL de una cadena.

function extractUrls(text) {
    // Utilice una expresión regular para que coincida con todas las URL de la cadena.

    return text.match(/\bhttps?:\/\/\S+/gi) || [];
}

// Define una función asincrónica para manejar la respuesta de un modelo con base en el mensaje original
async function handleModelResponse(botMessage, responseFunc, originalMessage) {
    // Obtiene el ID del usuario que envió el mensaje original
    const userId = originalMessage.author.id;

    try {
        // Espera la respuesta del modelo, que se supone es una llamada asincrónica
        const messageResult = await responseFunc();
        let finalResponse = ""; // Inicializa una variable para almacenar la respuesta completa
        let isLargeResponse = false; // Marca si la respuesta es demasiado larga para ser enviada en un solo mensaje

        // Itera sobre cada "chunk" de datos de la respuesta (asumiendo que es una transmisión/stream)
        for await (const chunk of messageResult.stream) {
            const chunkText = await chunk.text(); // Convierte el chunk a texto
            finalResponse += chunkText; // Agrega el texto convertido a la respuesta final

            // Si la respuesta se ha vuelto demasiado larga (>1900 caracteres) y aún no se ha marcado así, actualiza el mensaje
            if (!isLargeResponse && finalResponse.length > 1900) {
                await botMessage.edit(
                    "The response is too large and will be sent as a text file once it is ready."
                );
                isLargeResponse = true; // Marca que la respuesta está siendo enviada como un archivo de texto
            } else if (!isLargeResponse) {
                // Si la respuesta aún no es demasiado larga, edita el mensaje actual con la respuesta parcial
                await botMessage.edit({ content: finalResponse });
            }
        }

        // Si la respuesta fue marcada como demasiado larga, envía la respuesta completa como un archivo de texto
        if (isLargeResponse) {
            await sendAsTextFile(finalResponse, originalMessage);
        } else {
            // Si la respuesta no es demasiado larga, agrega un botón de configuración (o realiza alguna acción posrespuesta)
            await addSettingsButton(botMessage);
        }

        // Actualiza el historial de chat con la pregunta y respuesta para futuras referencias
        updateChatHistory(
            originalMessage.author.id,
            originalMessage.content
                .replace(new RegExp(`<@!?${client.user.id}>`), "") // Elimina la mención al bot del mensaje original
                .trim(),
            finalResponse
        );
    } catch (error) {
        // En caso de cualquier error durante el proceso, lo registra y notifica al usuario
        console.error("Error handling model response:", error);
        await botMessage.edit({
            content: "Sorry, an error occurred while generating a response.",
        });
    } finally {
        // Independientemente del resultado, elimina el ID del usuario de la lista de solicitudes activas
        activeRequests.delete(userId);
    }
}

// Esta función envía un texto dado como un archivo de texto en un mensaje de Discord.
async function sendAsTextFile(text, message) {
    // Crea un nombre de archivo para el archivo de texto con la marca de tiempo actual.
    const filename = `response-${Date.now()}.txt`;

    // Escribe el texto en el archivo.
    await writeFile(filename, text);

    // Envía el mensaje con el archivo adjunto.
    await message.reply({ content: "Aquí está la respuesta:", files: [filename] });

    // Limpia: elimina el archivo después de enviarlo.
    await unlink(filename);
}

// Función para convertir un archivo adjunto a un objeto de parte para su uso en un mensaje de Discord.
async function attachmentToPart(attachment) {
    // Obtiene el archivo adjunto de la URL.
    const response = await fetch(attachment.url);

    // Lee el archivo adjunto como un búfer.
    const buffer = await response.buffer();

    // Crea un objeto de parte con los datos del archivo adjunto y el tipo MIME.
    return {
        inlineData: {
            data: buffer.toString("base64"), // Convierte el búfer a una cadena codificada en base64.
            mimeType: attachment.contentType, // Utiliza el tipo de contenido del archivo adjunto como tipo MIME.
        },
    };
}

// Función para extraer texto de un archivo PDF
async function extractTextFromPDF(url) {
    try {
        // Obtiene el archivo PDF de la URL dada.
        const response = await fetch(url);

        // Lee el archivo PDF como un búfer.
        const buffer = await response.buffer();

        // Utiliza la biblioteca 'pdf' para extraer texto del búfer PDF.
        let data = await pdf(buffer);

        // Devuelve el texto extraído.
        return data.text;
    } catch (error) {
        // Registra el error y lanza un nuevo error.
        console.error("Error extrayendo texto del PDF:", error);
        throw new Error("No se pudo extraer el texto del PDF");
    }
}

// Función para obtener texto de un archivo de texto sin formato
async function fetchTextFile(url) {
    try {
        // Obtiene el archivo de texto sin formato de la URL dada.
        const response = await fetch(url);

        // Lee el archivo de texto sin formato como texto.
        return await response.text();
    } catch (error) {
        // Registra el error y lanza un nuevo error.
        console.error("Error obteniendo el archivo de texto:", error);
        throw new Error("No se pudo obtener el texto del archivo");
    }
}

// Función para obtener el historial de chat de un usuario específico.
function getHistory(userId) {
    // Comprueba si el usuario tiene un historial de chat.
    if (chatHistories[userId]) {
        // Si lo tiene, mapea cada línea de su conversación a un objeto con el rol ("usuario" o "modelo") y las partes de la conversación.
        return chatHistories[userId]?.map((line, index) => ({
            role: index % 2 === 0 ? "usuario" : "modelo", // Alterna el rol en función del índice de la línea (par para el usuario, impar para el modelo).
            parts: line, // Las partes de la conversación para la línea actual.
        }));
    } else {
        // Si el usuario no tiene un historial de chat, devuelve una matriz vacía.
        return [];
    }
}

// Función para actualizar el historial de chat de un usuario específico.
function updateChatHistory(userId, userMessage, modelResponse) {
    // Comprueba si el usuario ya tiene un historial de chat.
    if (!chatHistories[userId]) {
        // Si no, crea una matriz vacía para su historial de chat.
        chatHistories[userId] = [];
    }

    // Añade el mensaje del usuario a su historial de chat.
    chatHistories[userId].push(userMessage);

    // Añade la respuesta del modelo al historial de chat del usuario.
    chatHistories[userId].push(modelResponse);
}

// Función para añadir un botón de configuración a un mensaje de Discord.
async function addSettingsButton(botMessage) {
    // Crea un nuevo botón para el menú de configuración.
    const settingsButton = new ButtonBuilder()
        .setCustomId("settings") // Establece la ID personalizada del botón en "settings".
        .setEmoji("⚙️") // Establece el emoji del botón en un engranaje.
        .setStyle(ButtonStyle.Secondary); // Establece el estilo del botón en secundario.

    // Crea una fila de acción con el botón de configuración.
    const actionRow = new ActionRowBuilder().addComponents(settingsButton);

    // Edita el mensaje del bot para incluir la fila de acción con el botón de configuración.
    await botMessage.edit({ components: [actionRow] });
}

// Inicia sesión en el bot de Discord usando el token del bot de la variable de entorno.
client.login(process.env.DISCORD_BOT_TOKEN);