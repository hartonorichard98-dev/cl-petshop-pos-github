CREATE TABLE IF NOT EXISTS pos_staff (
  username VARCHAR(40) PRIMARY KEY,
  display_name VARCHAR(120) NOT NULL,
  role ENUM('owner', 'cashier') NOT NULL,
  pin_hash CHAR(64) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales (
  id VARCHAR(64) PRIMARY KEY,
  receipt_number VARCHAR(80) NOT NULL,
  cashier_name VARCHAR(120) NOT NULL,
  business_date DATE NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  status VARCHAR(20) NOT NULL,
  total BIGINT NOT NULL DEFAULT 0,
  cost_total BIGINT NULL,
  payment_method VARCHAR(20) NOT NULL DEFAULT 'cash',
  payload JSON NOT NULL,
  UNIQUE KEY sales_receipt_number_uq (receipt_number),
  KEY sales_business_date_idx (business_date),
  KEY sales_updated_at_idx (updated_at),
  KEY sales_created_at_idx (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS expenses (
  id VARCHAR(64) PRIMARY KEY,
  business_date DATE NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  status VARCHAR(20) NOT NULL,
  amount BIGINT NOT NULL DEFAULT 0,
  payload JSON NOT NULL,
  KEY expenses_business_date_idx (business_date),
  KEY expenses_updated_at_idx (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
  local_id BIGINT PRIMARY KEY,
  sku VARCHAR(100) NOT NULL,
  stock INT NOT NULL DEFAULT 0,
  track_stock TINYINT(1) NOT NULL DEFAULT 0,
  updated_at DATETIME(6) NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY products_sku_uq (sku),
  KEY products_updated_at_idx (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_movements (
  id VARCHAR(100) PRIMARY KEY,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  payload JSON NOT NULL,
  KEY inventory_movements_updated_at_idx (updated_at),
  KEY inventory_movements_created_at_idx (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_change_requests (
  id VARCHAR(100) PRIMARY KEY,
  requested_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  payload JSON NOT NULL,
  KEY inventory_requests_updated_at_idx (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS receivings (
  id VARCHAR(100) PRIMARY KEY,
  receiving_number VARCHAR(100) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  deleted_at DATETIME(6) NULL,
  status VARCHAR(30) NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY receivings_number_uq (receiving_number),
  KEY receivings_updated_at_idx (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_opnames (
  id VARCHAR(100) PRIMARY KEY,
  opname_date DATE NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  status VARCHAR(30) NOT NULL,
  payload JSON NOT NULL,
  KEY stock_opnames_date_idx (opname_date),
  KEY stock_opnames_updated_at_idx (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(160) PRIMARY KEY,
  created_at DATETIME(6) NOT NULL,
  payload JSON NOT NULL,
  KEY audit_logs_created_at_idx (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sale_deletions (
  sale_id VARCHAR(64) PRIMARY KEY,
  deleted_at DATETIME(6) NOT NULL,
  KEY sale_deletions_deleted_at_idx (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
