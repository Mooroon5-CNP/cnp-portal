FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT={{APP_PORT}}
EXPOSE {{APP_PORT}}
CMD ["python", "app.py"]
