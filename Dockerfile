FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DB_PATH=/app/data/asistencia.db
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["npm", "start"]
