import { buildApp } from './app';

const PORT = Number(process.env.PORT ?? 8080);

buildApp().listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
