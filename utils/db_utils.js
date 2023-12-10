const { Pool } = require("pg");

const pgPool = new Pool({
    user: process.env.PG_USER,
    password: process.env.PG_PASS,
    host: `c-${process.env.PG_CLUSTER}.rw.mdb.yandexcloud.net`,
    port: 6432,
    database: process.env.PG_DBNAME,
});

const selectQuery = "SELECT * FROM users WHERE vk_id = $1 OR tg_id = $2";
const insertQuery = "INSERT INTO users (vk_id, tg_id, status) VALUES ($1, $2, $3)";
const updateQuery = "UPDATE users SET vk_id = $1, tg_id = $2, status = $3 WHERE id = $4";

const ConfirmationStatus = Object.freeze({ CONFIRMED: "confirmed", WAIT_VK: "wait_vk", WAIT_TG: "wait_tg" });

module.exports = { pgPool, selectQuery, insertQuery, updateQuery, ConfirmationStatus };