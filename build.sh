eval $(op signin)
op run --env-file=.env -- npm run build:frontend
op run --env-file=.env -- docker compose up --build
