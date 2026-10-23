require('dotenv').config();
const { app } = require('./app');
const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => console.log(`IOSPRIVATE API ouvindo em 0.0.0.0:${port}`));
