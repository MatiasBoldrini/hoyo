# Publicación y operaciones

Este proyecto separa tres autoridades:

- el navegador muestra el catálogo y solicita operaciones;
- PostgreSQL decide disponibilidad, precio, ownership y estado;
- las Edge Functions crean el checkout y confirman pagos únicamente después de verificar al proveedor.

Nunca se debe aceptar desde el navegador un precio, una moneda, un owner o un estado de pago.

## Requisitos

- Node.js y npm;
- Supabase CLI autenticada y el proyecto enlazado;
- Deno para validar las Edge Functions;
- una cuenta PayPal Business habilitada para recibir USD;
- un dominio HTTPS definitivo.

Stripe queda disponible como adaptador opcional, pero solo debe habilitarse si el comercio opera mediante
una entidad admitida por Stripe. Una tarjeta o cuenta bancaria estadounidense por sí sola no vuelve
elegible a un comercio argentino.

## Variables del sitio

Copiar `.env.example` a `.env.local` y completar únicamente valores públicos:

```dotenv
VITE_SUPABASE_URL=https://PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

Las credenciales privadas de pagos no pertenecen a archivos `VITE_*`, al repositorio ni al hosting del
frontend.

En Supabase Auth se debe configurar:

- **Site URL** con el origen HTTPS definitivo;
- **Redirect URLs** con el mismo origen y las rutas usadas por Magic Link;
- proveedores anónimos habilitados solo si Party los necesita;
- email/Magic Link habilitado para conservar ownership y compras.

## Secretos de Edge Functions

Configurar desde un entorno seguro:

```sh
supabase secrets set \
  APP_ENV=production \
  PAYMENT_PROVIDER=paypal \
  PAYMENT_ITEM_NAME='Hoyo sponsor takeover' \
  CHECKOUT_TTL_SECONDS=900 \
  PAYPAL_ENV=live \
  PAYPAL_CLIENT_ID='...' \
  PAYPAL_CLIENT_SECRET='...' \
  PAYPAL_WEBHOOK_ID='...' \
  PAYMENT_RETURN_SECRET='...' \
  CORS_ALLOWED_ORIGINS='https://example.com' \
  PAYMENT_REDIRECT_ORIGINS='https://example.com' \
  PAYPAL_CAPTURE_URL='https://PROJECT_REF.supabase.co/functions/v1/payment-paypal-capture'
```

`PAYMENT_RETURN_SECRET` debe ser aleatorio y mantenerse fuera del repositorio. Las allowlists usan
orígenes exactos, sin `*`.

En PayPal se debe registrar el webhook de:

```text
https://PROJECT_REF.supabase.co/functions/v1/payment-webhook
```

Los eventos necesarios y el procedimiento de captura están documentados en
`supabase/functions/README.md`.

## Verificación previa

```sh
npm ci
npm test
npm run check:catalog
npm run build

cd supabase/functions
deno fmt --check
deno lint
deno task check
deno task test
cd ../..
```

Antes de publicar, confirmar que no hay timestamps duplicados:

```sh
find supabase/migrations -maxdepth 1 -type f -exec basename {} \; | cut -c1-14 | sort | uniq -d
```

## Base de datos

Revisar primero el plan contra el proyecto enlazado:

```sh
supabase migration list --linked
supabase db push --linked --include-all --dry-run
```

Si el plan contiene solamente las migraciones revisadas:

```sh
supabase db push --linked --include-all
supabase db lint --linked
supabase migration list --linked
```

No marcar migraciones como aplicadas manualmente salvo que se haya comprobado que el SQL equivalente
ya existe en el servidor.

## Edge Functions

```sh
supabase functions deploy create-payment-checkout --use-api
supabase functions deploy payment-webhook --use-api
supabase functions deploy payment-paypal-capture --use-api
```

Luego comprobar que los secretos estén presentes por nombre:

```sh
supabase secrets list
supabase functions list
```

## Prueba de aceptación

1. Abrir el sitio sin sesión y recorrer la ciudad.
2. Iniciar sesión por Magic Link.
3. Reclamar un único espacio gratis.
4. Verificar que un segundo espacio cotice USD 100 y no pueda reclamarse gratis.
5. Completar un pago PayPal en sandbox.
6. Confirmar que volver por la URL de éxito no active el sponsor por sí mismo.
7. Confirmar que el webhook completa la orden una sola vez y que un evento repetido es idempotente.
8. Moderar el branding y verificar que recién entonces sea público.
9. Reemplazar un espacio ocupado y comprobar que el próximo precio pase de USD 100 a USD 200.
10. Abrir dos navegadores, crear una Party, entrar por enlace y comprobar que ambos jugadores se ven.

También se deben probar cancelación, reserva vencida, webhook inválido, versión obsoleta, dominio
duplicado, noveno participante y pérdida/recuperación de sesión.

## Operación

- Ejecutar periódicamente la liberación de reservas vencidas.
- Moderar branding pendiente antes de publicarlo.
- Mantener órdenes, eventos de pago y datos administrativos fuera de las vistas públicas.
- No considerar una redirección de checkout como evidencia de pago.
- Para reembolsos y disputas, conservar el identificador de orden interno y el del proveedor.
- Coordinar facturación, impuestos y recepción de fondos con un contador argentino.
