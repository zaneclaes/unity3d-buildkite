const path = require('path');
const gitRoot = path.normalize(path.join(__dirname, '..', '..'));
module.exports = require('./').configs.nodelint(__dirname, gitRoot);
