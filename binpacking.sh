#!/bin/bash
set -e

echo "=========================================="
echo "       OpalaTex - Gerador de Release      "
echo "=========================================="

# Usando caminhos relativos para rodar liso no Linux ou Mac
DIST_DIR="dist/OpalaTex"
ZIP_NAME="dist/OpalaTex-linux-x64.zip"
VPS_IP="REDACTED_RELEASE_HOST"
VPS_USER="REDACTED_RELEASE_USER"
VPS_DEST_DIR="/root/opala-api/apps/web/public/downloads"

echo ""
echo "[1/3] Verificando se a pasta do executavel foi gerada..."
if [ ! -d "$DIST_DIR" ]; then
    echo "Erro: Pasta $DIST_DIR nao encontrada. Verifique se o executavel linux foi compilado!"
    exit 1
fi

echo ""
echo "[2/3] Compactando o executavel (OpalaTex-linux-x64.zip)..."
if [ -f "$ZIP_NAME" ]; then
    rm -f "$ZIP_NAME"
fi

# Entramos na pasta para zipar os arquivos e nao a pasta inteira, mantendo a mesma logica do windows
cd dist/OpalaTex
zip -r ../OpalaTex-linux-x64.zip ./*
cd ../..

echo ""
echo "[3/3] Fazendo upload para a VPS ($VPS_IP)..."
echo "Isso pode levar alguns minutos. (Digite a senha da VPS quando solicitado)"
ssh "${VPS_USER}@${VPS_IP}" "mkdir -p $VPS_DEST_DIR"
scp "$ZIP_NAME" "${VPS_USER}@${VPS_IP}:${VPS_DEST_DIR}/"

echo ""
echo "=========================================="
echo "Upload concluido com sucesso!"
echo "Link publico: https://opalacoder.com/downloads/OpalaTex-linux-x64.zip"
echo "=========================================="
