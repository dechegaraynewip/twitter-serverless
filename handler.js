const config = require('./config/config.json'); // Cargar config.json
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const request = require('request-promise-native');
const AWS = require('aws-sdk');
const dynamoDb = new AWS.DynamoDB.DocumentClient();

const oauth = OAuth({
  consumer: { key: config.CONSUMER_KEY, secret: config.CONSUMER_SECRET },
  signature_method: 'HMAC-SHA1',
  hash_function(base_string, key) {
    return crypto.createHmac('sha1', key).update(base_string).digest('base64');
  },
});

const token = {
  key: config.TOKEN_KEY,
  secret: config.TOKEN_SECRET,
};

// Función para recibir mensajes de Twitter (GET)
module.exports.getTwitterMessages = async (event) => {
  const request_data = {
    url: 'https://api.x.com/2/dm_events',
    method: 'GET',
  };

  try {
    const response = await request({
      url: request_data.url,
      method: request_data.method,
      headers: oauth.toHeader(oauth.authorize(request_data, token)),
      json: true,  // Asegura que la respuesta sea un objeto JSON
      resolveWithFullResponse: true, // Esto incluye los headers y status code en la respuesta
    });

    // Manejo de respuesta exitosa (Status 200)
    if (response.statusCode === 200) {
      const data = response.body;

      // Verifica si tiene el formato correcto
      if (data.data && Array.isArray(data.data) && data.meta) {
        for (const message of data.data) {
          const messageId = message.id;

          // Verificar si el mensaje ya existe en DynamoDB
          const params = {
            TableName: 'Messages',
            Key: {
              MessageId: messageId,
            },
          };

          const existingMessage = await dynamoDb.get(params).promise();

          if (!existingMessage.Item) {
            // El mensaje no existe, guardarlo en DynamoDB
            const putParams = {
              TableName: 'Messages',
              Item: {
                MessageId: messageId,
                MessageContent: message.text || 'No text provided',
                EventType: message.event_type || 'Unknown event type',
                Timestamp: new Date().toISOString(),
              },
            };

            await dynamoDb.put(putParams).promise();
            console.log(`Mensaje con ID ${messageId} agregado a DynamoDB.`);
          } else {
            console.log(`Mensaje con ID ${messageId} ya existe. No se agregará.`);
          }
        }

        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "Request Successful",
            data: data.data,
            result_count: data.meta.result_count,
          }),
        };
      } else {
        // Formato inesperado
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Unexpected response format' }),
        };
      }
    }
  } catch (error) {
    // Manejo de errores
    if (error.statusCode === 429) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          title: 'Too Many Requests',
          detail: 'You have sent too many requests in a given amount of time.',
        }),
      };
    } else if (error.statusCode === 500) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Internal Server Error',
          detail: error.message,
        }),
      };
    } else {
      return {
        statusCode: error.statusCode || 400,
        body: JSON.stringify({
          error: 'Request failed',
          detail: error.message,
        }),
      };
    }
  }
};


// Función para enviar mensajes de Twitter (POST)
module.exports.sendTwitterMessage = async (event) => {
  const id = event.pathParameters.id;
  const text = event.queryStringParameters?.text;

  if (!text) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Text parameter is required and cannot be empty.',
      }),
    };
  }

  const request_data = {
    url: `https://api.x.com/2/dm_conversations/with/${id}/messages`,
    method: 'POST',
    json: {
      text,
      attachments: []
    }
  };

  try {
    const response = await request({
      url: request_data.url,
      method: request_data.method,
      headers: oauth.toHeader(oauth.authorize(request_data, token)),
      body: request_data.json,
      json: true,
      resolveWithFullResponse: true,
    });

    return {
      statusCode: response.statusCode,
      body: JSON.stringify({
        message: "Message sent successfully",
        data: response.body,
      }),
    };
  } catch (error) {
    if (error.statusCode === 429) {
      return {
        statusCode: 429,
        body: JSON.stringify({
          title: 'Too Many Requests',
          detail: 'You have sent too many requests in a given amount of time.',
        }),
      };
    } else if (error.statusCode === 500) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Internal Server Error',
          detail: error.message,
        }),
      };
    } else {
      return {
        statusCode: error.statusCode || 400,
        body: JSON.stringify({
          error: 'Request failed',
          detail: error.message,
        }),
      };
    }
  }
};

// Función para manejar el webhook
module.exports.githubWebhookHandler = async (event) => {
  // Parsear el cuerpo del evento como JSON
  const body = JSON.parse(event.body);
  const eventType = event.headers['X-GitHub-Event'];

  try {
    // Crear un nuevo ID para el evento
    const eventId = body.id || Date.now().toString();

    // Configurar los parámetros para guardar en DynamoDB
    const params = {
      TableName: 'GitHubEvents', // Nombre de la tabla DynamoDB
      Item: {
        EventId: eventId, // ID del evento, usando body.id o un timestamp si no está disponible
        EventType: eventType, // Tipo de evento de GitHub (push, pull_request, etc.)
        EventSource: body.sender ? body.sender.login : 'Unknown', // Quien generó el evento (login del usuario)
        Repository: body.repository ? body.repository.full_name : 'Unknown', // Nombre del repositorio
        Timestamp: new Date().toISOString(), // Fecha y hora del evento
        EventDetails: JSON.stringify(body), // Detalles completos del evento, guardados como string
      },
    };

    // Guardar en DynamoDB
    await dynamoDb.put(params).promise();

    // Responder con éxito
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Webhook received and event saved successfully' }),
    };
  } catch (error) {
    console.error('Error saving event to DynamoDB:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal Server Error',
        detail: error.message,
      }),
    };
  }
};
