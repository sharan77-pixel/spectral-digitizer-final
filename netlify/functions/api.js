const serverless = require('serverless-http');
const app = require('../../server');

// Wrap the Express app with serverless-http
const handler = serverless(app);

module.exports.handler = async (event, context) => {
  // If the path starts with the Netlify function prefix, rewrite it to /api for Express routing
  if (event.path && event.path.startsWith('/.netlify/functions/api')) {
    event.path = event.path.replace('/.netlify/functions/api', '/api');
  }
  return await handler(event, context);
};
