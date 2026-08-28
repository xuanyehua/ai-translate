SHELL := /bin/bash

BACKEND_HOST ?= 127.0.0.1
BACKEND_PORT ?= 8000
FRONTEND_HOST ?= 127.0.0.1
FRONTEND_PORT ?= 5173
MINERU_MODEL_SOURCE ?= modelscope

.PHONY: help install dev backend frontend build test

help:
	@printf '%s\n' \
		'make install   安装 Python 和前端依赖' \
		'make dev       同时启动后端与前端' \
		'make backend   仅启动 FastAPI（会自动启动 MinerU）' \
		'make frontend  仅启动 Vite 前端' \
		'make build     构建前端生产资源' \
		'make test      运行后端测试'

install:
	uv sync
	npm ci --prefix frontend

dev:
	@set -e; \
		cleanup() { \
			kill "$$backend_pid" 2>/dev/null || true; \
			wait "$$backend_pid" 2>/dev/null || true; \
		}; \
		trap cleanup EXIT INT TERM; \
		MINERU_MODEL_SOURCE=$(MINERU_MODEL_SOURCE) uv run uvicorn app.main:app --host $(BACKEND_HOST) --port $(BACKEND_PORT) & \
		backend_pid=$$!; \
		cd frontend && npm run dev -- --host $(FRONTEND_HOST) --port $(FRONTEND_PORT)

backend:
	MINERU_MODEL_SOURCE=$(MINERU_MODEL_SOURCE) uv run uvicorn app.main:app --host $(BACKEND_HOST) --port $(BACKEND_PORT)

frontend:
	npm run dev --prefix frontend -- --host $(FRONTEND_HOST) --port $(FRONTEND_PORT)

build:
	npm run build --prefix frontend

test:
	uv run pytest
