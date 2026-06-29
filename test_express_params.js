const express = require('express');
const app = express();

const requirePermission = (req, res, next) => {
  console.log('Middleware req.params:', req.params);
  next();
};

const router = express.Router();
router.get('/servers/:id/files', requirePermission, (req, res) => {
  res.send('ok');
});

app.use('/api', router);

app.listen(3000, async () => {
  await fetch('http://localhost:3000/api/servers/1/files');
  process.exit(0);
});
