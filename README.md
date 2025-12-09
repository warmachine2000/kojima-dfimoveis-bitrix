# Integração DF Imóveis / 62 Imóveis → Bitrix24

Projeto privado contendo a API dedicada para recebimento de leads dos portais:
- **DF Imóveis**
- **62 Imóveis**

Autor: **Adriano Alves**

## 🚀 Rotas

### POST /api/dfimoveis
Recebe o payload do Grupo OLX/Zap e cria um Lead no Bitrix24.

## 🔒 Segurança
- Autenticação via Token pelo Header: `x-webhook-token`
- Repositório privado (GitHub)
- Deploy com proteção e logs no Vercel
