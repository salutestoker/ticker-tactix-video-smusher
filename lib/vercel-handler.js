const { app } = require('./app');

function handlerFor(pathname) {
  return (req, res) => {
    const queryStart = req.url.indexOf('?');
    const query = queryStart === -1 ? '' : req.url.slice(queryStart);
    req.url = `${pathname}${query}`;
    return app(req, res);
  };
}

module.exports = {
  handlerFor
};
