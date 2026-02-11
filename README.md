# GenTrack

Aplicacao web para monitorar sites com:
- Uptime por alvo
- Codigo HTTP de resposta
- Latencia (ms)
- Historico de checks

## Requisitos
- Python 3.10+ (testado com Python 3.14)
- PostgreSQL acessivel pela `DATABASE_URL`

## Instalar dependencias
```bash
python -m pip install -r requirements.txt
```

## Executar localmente
Defina a conexao do banco:
```bash
set DATABASE_URL=postgres://gentrack:Pilotofab123!@72.60.158.28:6789/GenTrack-db?sslmode=disable
```

Depois:
```bash
python app.py
```

Abra:
`http://127.0.0.1:5000`

## Deploy no EasyPanel
Este repositorio ja esta pronto para EasyPanel com `Dockerfile`.

1. Crie um app via Git Repository.
2. Use `Dockerfile` como Build Strategy.
3. Configure as variaveis de ambiente:
```env
DATABASE_URL=postgres://gentrack:Pilotofab123!@72.60.158.28:6789/GenTrack-db?sslmode=disable
PORT=5000
MONITOR_POLL_SECONDS=5
DEFAULT_INTERVAL_SECONDS=60
DEFAULT_TIMEOUT_SECONDS=8
```
Alternativas suportadas para conexao: `POSTGRES_URL`, `POSTGRESQL_URL`, `DB_URL`
ou variaveis separadas: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
4. Configure Healthcheck: `GET /health`
5. Porta interna: `5000`

Comando de start (ja definido no Dockerfile):
`gunicorn --bind 0.0.0.0:${PORT} --workers 1 --threads 4 --timeout 120 wsgi:app`

## Como funciona
- Cadastre URLs no painel.
- O monitor roda em background e grava resultados no PostgreSQL.
- Tambem e possivel forcar um check manual por alvo no painel.
