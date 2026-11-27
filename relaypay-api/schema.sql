CREATE TABLE IF NOT EXISTS rp_users (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  google_sub VARCHAR(64) NOT NULL,
  email VARCHAR(190) NOT NULL,
  name VARCHAR(80) NULL,
  picture VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP NULL,
  UNIQUE KEY rp_users_google_sub (google_sub),
  UNIQUE KEY rp_users_email (email)
);

CREATE TABLE IF NOT EXISTS rp_sessions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  csrf_token VARCHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY rp_sessions_token_hash (token_hash),
  KEY rp_sessions_user_id_idx (user_id),
  KEY rp_sessions_expires_at_idx (expires_at),
  CONSTRAINT rp_sessions_user_fk FOREIGN KEY (user_id) REFERENCES rp_users (id) ON DELETE CASCADE
);
